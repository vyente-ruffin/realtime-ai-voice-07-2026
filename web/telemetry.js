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
  }

  /** Snapshot identity now, never through mutable global connection state. */
  record(call, type, detail = {}) {
    if (!call) return;
    this.queue.push({ id: crypto.randomUUID(), conversation: call.conversation, session: call.session,
      callId: call.id, ts: Date.now(), type, detail });
    if (this.queue.length > 100) this.queue.splice(0, this.queue.length - 100);
  }

  /** Capture browser-observed states; a channel close event supplies no network root cause. */
  states(call) {
    return {
      ...(call.peer?.connectionState ? { connectionState: call.peer.connectionState } : {}),
      ...(call.peer?.iceConnectionState ? { iceState: call.peer.iceConnectionState } : {}),
      ...(call.channel?.readyState ? { channelState: call.channel.readyState } : {}),
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
      try {
        while (this.queue.length) {
          const conversation = this.queue[0].conversation;
          const events = this.queue.filter(e => e.conversation === conversation).slice(0, 20);
          await this.post({ conversation, events });
          const ids = new Set(events.map(e => e.id));
          this.queue = this.queue.filter(e => !ids.has(e.id));
        }
      } catch {} // A transient diagnostics failure must not interrupt the call.
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
      try { this.beacon({ conversation, events }); } catch {}
    }
  }
}
