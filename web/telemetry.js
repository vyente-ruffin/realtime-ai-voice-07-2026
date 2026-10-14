/** Compact local diagnostics, using W3C WebRTC Stats and the Beacon API (see ledger). */
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Sum only inbound audio; W3C jitter and selected ICE-pair RTT are seconds. */
export function summarizeAudio(report) {
  let packetsReceived = 0, bytesReceived = 0, jitterSeconds = null, roundTripTimeSeconds = null;
  for (const stat of report.values()) {
    if (stat.type === "inbound-rtp" && (stat.kind || stat.mediaType) === "audio") {
      packetsReceived = packetsReceived !== null && finite(stat.packetsReceived) ? packetsReceived + stat.packetsReceived : null;
      bytesReceived = bytesReceived !== null && finite(stat.bytesReceived) ? bytesReceived + stat.bytesReceived : null;
      if (finite(stat.jitter)) jitterSeconds = Math.max(jitterSeconds || 0, stat.jitter);
    }
    if (stat.type === "transport") {
      const pair = report.get(stat.selectedCandidatePairId);
      if (finite(pair?.currentRoundTripTime)) roundTripTimeSeconds = pair.currentRoundTripTime;
    }
  }
  return { packetsReceived, bytesReceived, jitterSeconds, roundTripTimeSeconds };
}

/** Bounded best-effort diagnostics; outages must never block speech or create recursive errors. */
export class BrowserTelemetry {
  /** Inject authenticated transport so the app's existing token refresh remains authoritative. */
  constructor({ post, beacon }) {
    this.post = post;
    this.beacon = beacon;
    this.queue = [];
    this.sending = null;
    // Loss accounting per originating call ID, so one call's outage is never blamed on another;
    // each call's losses are reported as its own telemetry.gap event after the next successful post.
    this.lost = new Map();
  }

  /** A client call ID correlates failures occurring before Azure assigns a live session ID. */
  begin(conversation) {
    const call = { id: crypto.randomUUID(), conversation, session: null, ended: false,
      stats: { statsStatus: "unavailable", audioReceived: null, sampledAt: null,
        packetsReceived: null, bytesReceived: null, jitterSeconds: null, roundTripTimeSeconds: null } };
    this.record(call, "connection.started");
    return call;
  }

  /** Update unsent pre-handshake events; already shipped events retain their common call ID. */
  bind(call, session) {
    call.session = session;
    for (const event of this.queue) if (event.callId === call.id) event.session = session;
    if (this.lost.has(call.id)) this.lost.get(call.id).session = session;
  }

  /** Snapshot identity now, never through mutable global connection state. */
  record(call, type, detail = {}) {
    if (!call) return;
    this.queue.push({ id: crypto.randomUUID(), conversation: call.conversation, session: call.session,
      callId: call.id, ts: Date.now(), type, detail });
    if (this.queue.length > 100)
      for (const dropped of this.queue.splice(0, this.queue.length - 100)) {
        const lost = this.loss(dropped);
        // A dropped gap report still carries counts; keep them rather than losing the loss evidence.
        if (dropped.type === "telemetry.gap") for (const key of Object.keys(dropped.detail)) lost[key] += dropped.detail[key];
        else lost.droppedEvents++;
      }
  }

  /** Loss counters for the call that produced an event, keyed by its own call ID. */
  loss(event) {
    let lost = this.lost.get(event.callId);
    if (!lost) this.lost.set(event.callId, lost = { conversation: event.conversation, session: event.session,
      droppedEvents: 0, failedFlushes: 0, beaconRefused: 0 });
    lost.session = event.session ?? lost.session;
    return lost;
  }

  /** Count one failed delivery against every call that had events in it. */
  lose(events, counter) {
    for (const callId of new Set(events.map(e => e.callId)))
      this.loss(events.find(e => e.callId === callId))[counter]++;
  }

  /** Capture browser-observed states; a channel close event supplies no network root cause.
   * Microphone state follows MediaStreamTrack: muted = source gave no data, enabled = app mute.
   * Playback "playing" means HTMLMediaElement.play() resolved, never that speech was audible. */
  states(call) {
    const mic = call.microphone;
    const microphoneState = !mic ? null : mic.readyState === "ended" ? "ended" : !mic.enabled ? "disabled" : mic.muted ? "muted" : "live";
    const audioContextState = ["suspended", "running", "closed", "interrupted"].includes(call.audioContext?.state) ? call.audioContext.state : null;
    return {
      ...(call.peer?.connectionState ? { connectionState: call.peer.connectionState } : {}),
      ...(call.peer?.iceConnectionState ? { iceState: call.peer.iceConnectionState } : {}),
      ...(call.channel?.readyState ? { channelState: call.channel.readyState } : {}),
      ...(microphoneState ? { microphoneState } : {}),
      ...(call.playbackState ? { playbackState: call.playbackState } : {}),
      ...(audioContextState ? { audioContextState } : {}),
    };
  }

  /** Bounded native getStats sampling; preserve positive receipt evidence if later stats disappear. */
  sample(call) {
    if (!call?.peer?.getStats) return Promise.resolve();
    if (call.sampling) return call.sampling;
    call.sampling = (async () => {
      let timer;
      try {
        const report = await Promise.race([
          call.peer.getStats(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Stats timeout")), 1000); }),
        ]);
        const summary = summarizeAudio(report);
        const received = summary.packetsReceived > 0 || summary.bytesReceived > 0;
        call.stats = { ...summary, statsStatus: "ok", sampledAt: Date.now(),
          audioReceived: call.stats.audioReceived === true || received ? true
            : summary.packetsReceived === null && summary.bytesReceived === null ? call.stats.audioReceived : false };
      } catch {
        call.stats = { ...call.stats, statsStatus: "error" };
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { call.sampling = null; });
    return call.sampling;
  }

  /** Emit one final close record after a last bounded sample; never await it in audio teardown. */
  async end(call, reason, requested) {
    if (!call || call.ended) return;
    call.ended = true;
    const states = this.states(call);
    // Navigation may destroy this promise: retain the observed cause before any await.
    this.record(call, "connection.ending", { ...states, ...call.stats, reason, requested });
    await this.sample(call);
    this.record(call, "call.ended", { ...states, ...call.stats, reason, requested });
    await this.flush();
  }

  /** Serialize small batches, retain unacknowledged events for the next periodic flush. */
  flush() {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      let events = [];
      try {
        while (this.queue.length) {
          const conversation = this.queue[0].conversation;
          events = this.queue.filter(e => e.conversation === conversation).slice(0, 20);
          await this.post({ conversation, events });
          const ids = new Set(events.map(e => e.id));
          this.queue = this.queue.filter(e => !ids.has(e.id));
          // Delivery works again: report each call's own losses under that call's ID; the loop sends them next.
          const lost = [...this.lost];
          this.lost = new Map();
          for (const [id, { conversation, session, ...counts }] of lost)
            this.record({ id, conversation, session }, "telemetry.gap", counts);
        }
      } catch {
        this.lose(events, "failedFlushes"); // A transient diagnostics failure must not interrupt the call.
      }
    })().finally(() => { this.sending = null; });
    return this.sending;
  }

  /** Beacon cannot confirm receipt. Keep queued events for retries if the page resumes. */
  checkpoint(call, exiting = false) {
    if (call && !call.ended) this.record(call, exiting ? "connection.page.exit" : "connection.page.hidden", {
      ...this.states(call), ...call.stats, ...(exiting ? { reason: "page_exit", requested: false } : {}),
    });
    const conversation = call?.conversation || this.queue.at(-1)?.conversation;
    const events = this.queue.filter(e => e.conversation === conversation).slice(-20);
    // Prioritize the last close evidence and remain well below Beacon's shared 64 KiB limit.
    if (events.length) {
      let queued = false;
      try { queued = this.beacon({ conversation, events }); } catch {}
      if (!queued) this.lose(events, "beaconRefused");
    }
  }
}
