// GPT-Live transport follows Hermes's installed voice-live.ts and Microsoft's
// WebRTC/client-delegation guides. Audio interruption never cancels an app job.
import { BrowserTelemetry } from "./telemetry.js";
import { MemoryContext } from "./memory-context.js";
const $ = (id) => document.getElementById(id);
let auth = document.querySelector('meta[name="voice-auth"]').content;
const saved = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
let conversation = saved("jarvis.conversation"),
  session = null,
  pc = null,
  dc = null,
  mic = null,
  ac = null,
  source = null,
  wake = null;
let connectEpoch = 0;
let wanted = false,
  connecting = false,
  retry = 0,
  retryTimer = null,
  closeTimer = null,
  muted = false,
  sending = null,
  deliveriesBusy = false;
let microphoneUntil = 0,
  speakerUntil = 0,
  lastSpeakerSample = 0;
let transcriptQueue = saved("jarvis.transcriptOutbox") || [];
let jobs = new Map(),
  appendAcks = new Map(),
  offered = new Set(),
  currentCaption = null,
  captionRole = null;
const synthetic = new URLSearchParams(location.search).get("synthetic") === "1";
let activeCall = null;
const telemetry = new BrowserTelemetry({
  post: body => api("/api/telemetry", body),
  // Beacon cannot set X-Voice-Auth; reuse the server's existing query-token auth.
  beacon: body => navigator.sendBeacon(`/api/telemetry?auth=${encodeURIComponent(auth)}`,
    new Blob([JSON.stringify(body)], { type: "application/json" })),
});
window.__voiceLabEvents = [];
function record(type, detail = {}, call = activeCall) {
  window.__voiceLabEvents.push({ ts: Date.now(), type, ...detail });
  if (window.__voiceLabEvents.length > 10000)
    window.__voiceLabEvents.splice(0, 1000);
  // Never ship raw provider events: these may contain speech, SDP or private tool results.
  if (type.startsWith("connection.")) {
    telemetry.record(call, type, detail);
    void telemetry.flush();
  }
}
function status(text) {
  $("status").textContent = text;
}
function message(text, role = "meta") {
  const d = document.createElement("div");
  d.className = `bubble ${role === "user" ? "you" : "model"}`;
  d.textContent = text;
  $("chat").append(d);
  $("chat").scrollTop = $("chat").scrollHeight;
  return d;
}
async function api(path, body, second = false) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Voice-Auth": auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path === "/api/live" ? 25000 : 8000),
  });
  if (response.status === 403 && !second) {
    const r = await fetch("/auth-refresh", {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error("Could not refresh the connection.");
    auth = (await r.json()).token;
    return api(path, body, true);
  }
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.detail || "Request failed."), {
      retryAfterMs: data.retryAfterMs || 0,
    });
  return data;
}
function send(event) {
  if (dc?.readyState !== "open") return false;
  dc.send(JSON.stringify(event));
  return true;
}
// UTF-8 bytes bound also bounds tokens, including non-English results.
function chunks(text) {
  const out = [];
  let part = "";
  for (const char of text) {
    if (new TextEncoder().encode(part + char).length > 480) {
      out.push(part);
      part = "";
    }
    part += char;
  }
  if (part) out.push(part);
  return out;
}
function append(type, text, delegation = null, id = crypto.randomUUID()) {
  const parts = chunks(text);
  if (dc?.readyState !== "open") return [];
  return parts.map((content, i) => {
    const event_id = `${id}_${i}`;
    send({ type, event_id, delegation_id: delegation, content });
    return event_id;
  });
}
let lastQuietSnapshot = "";
const memoryContext = new MemoryContext(append, (section) => record("memory.context.accepted", section));
let deliveryInFlight = null;
function quietJobs() {
  if (!session || !jobs.size) return;
  const snapshot = JSON.stringify(
    [...jobs.values()]
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 8)
      .map((j) => ({ id: j.id, state: j.state })),
  );
  if (snapshot === lastQuietSnapshot) return;
  lastQuietSnapshot = snapshot;
  append(
    "session.thinking.append",
    "Background task states, available when the user asks for status: " +
      snapshot,
  );
}

function renderJobs() {
  taskList.replaceChildren();
  for (const job of [...jobs.values()].sort((a, b) => b.created - a.created)) {
    const card = document.createElement("div");
    card.style.cssText =
      "padding:12px;border-top:1px solid var(--line);white-space:pre-wrap";
    const state = document.createElement("strong");
    state.textContent =
      {
        queued: "Waiting",
        running: "Working",
        awaiting_permission: "Needs your approval",
        completed: "Result ready",
        failed: "Could not finish",
        cancelled: "Stopped",
        interrupted: "Needs checking",
      }[job.state] || job.state;
    card.append(state);
    if (job.result || job.error) {
      const text = document.createElement("p");
      text.textContent = job.result || job.error;
      card.append(text);
    }
    if (["queued", "running", "awaiting_permission"].includes(job.state)) {
      const button = document.createElement("button");
      button.textContent = "Stop task";
      button.onclick = () =>
        api("/api/tasks/cancel", { conversation, job: job.id })
          .then((x) => updateJob(x.job))
          .catch(showError);
      card.append(button);
    }
    for (const permission of job.permissions || []) {
      const title = document.createElement("p");
      title.textContent = permission.title;
      card.append(title);
      for (const option of permission.options || []) {
        const button = document.createElement("button");
        button.textContent = option.name;
        button.onclick = () =>
          api("/api/permission", {
            conversation,
            job: job.id,
            id: permission.id,
            optionId: option.optionId,
          }).catch(showError);
        card.append(button);
      }
    }
    taskList.append(card);
  }
  taskPanel.hidden = jobs.size === 0;
}
function updateJob(job) {
  const before = jobs.get(job.id);
  if (before && job.updated < before.updated) return;
  jobs.set(job.id, job);
  renderJobs();
  if (!before || before.updated !== job.updated) {
    quietJobs();
    record("job.updated", { job: job.id, state: job.state });
  }
}
function showError(err) {
  status("⚠ " + err.message);
  record("app.error", { message: err.message });
}
/** Attribute asynchronous transport failures to their originating call, never a later reconnect. */
function connectionError(err, call) {
  showError(err);
  const errorName = ["Error", "NotAllowedError", "NotFoundError", "NotReadableError", "AbortError",
    "TimeoutError", "InvalidStateError", "OperationError", "RTCError", "SyntaxError", "TypeError"].includes(err.name)
    ? err.name : "UnknownError";
  record("connection.error", { errorName, reason: "connection_error" }, call);
}
function openEvents() {
  source?.close();
  source = new EventSource(
    `/api/events?conversation=${encodeURIComponent(conversation)}&auth=${encodeURIComponent(auth)}`,
  );
  source.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "snapshot") event.jobs.forEach(updateJob);
    else if (event.type === "job.updated") updateJob(event.job);
    else if (event.type === "memory.context") memoryContext.receive(event.models);
    else if (event.type === "memory.state") {
      const labels = {
        saving: "Saving memories…",
        saved: "Memories saved",
        pending: "Memory save queued — conversation is kept on this server",
        failed: "Some memories could not be saved. Your conversation is kept on this server.",
      };
      const unsent = transcriptQueue.some((x) => x.conversation === conversation && x.event.type === "session.input_transcript.delta");
      const state = event.state === "saved" && unsent ? "saving" : event.state;
      memoryStatus.textContent = labels[state] || "";
      if (state === "saved")
        append(
          "session.thinking.append",
          "Silent state update, not a request: the queued user statements have completed memory processing. Do not announce this unless asked.",
        );
    } else if (
      event.type === "session.active" &&
      session &&
      event.session !== session
    ) {
      wanted = false;
      teardown("session_replaced");
      status("The conversation moved to another connection.");
    }
  };
  source.onerror = async () => {
    source?.close();
    try {
      const data = await api(`/api/jobs?conversation=${conversation}`);
      data.jobs.forEach(updateJob);
      if (wanted) openEvents();
    } catch {
      setTimeout(() => {
        if (wanted) openEvents();
      }, 2000);
    }
  };
}
function flushTranscript() {
  // Reconnection must await an in-flight save and every older queued session.
  if (sending) return sending;
  if (!conversation || !transcriptQueue.length) return Promise.resolve();
  sending = (async () => {
    try {
      while (transcriptQueue.length) {
        const first = transcriptQueue[0];
        const group = transcriptQueue
          .filter(
            (x) =>
              x.session === first.session &&
              x.conversation === first.conversation,
          )
          .slice(0, 150);
        await api("/api/transcript", {
          conversation: first.conversation,
          session: first.session,
          events: group.map((x) => x.event),
        });
        const ids = new Set(group.map((x) => x.id));
        transcriptQueue = transcriptQueue.filter((x) => !ids.has(x.id));
        save("jarvis.transcriptOutbox", transcriptQueue);
      }
    } catch (err) {
      record("transcript.save.pending", { message: err.message });
    }
  })().finally(() => {
    sending = null;
  });
  return sending;
}
function transcript(event) {
  const role =
    event.type === "session.input_transcript.delta" ? "user" : "assistant";
  if (role !== captionRole || !currentCaption) {
    currentCaption = message("", role);
    captionRole = role;
  }
  currentCaption.textContent += event.delta || "";
  $("chat").scrollTop = $("chat").scrollHeight;
  transcriptQueue.push({
    id: crypto.randomUUID(),
    conversation,
    session,
    event,
  });
  try {
    save("jarvis.transcriptOutbox", transcriptQueue);
  } catch {
    showError(
      new Error(
        "Conversation storage is full. Keep this page open until it reconnects.",
      ),
    );
  }
}
async function delegate(event) {
  const delegation = event.delegation;
  if (!delegation?.id || delegation.target !== "client") return;
  try {
    const result = await api("/api/delegations", {
      conversation,
      session,
      delegation: delegation.id,
      events: transcriptQueue
        .filter((x) => x.session === session)
        .slice(-150)
        .map((x) => x.event),
    });
    updateJob(result.job);
  } catch (err) {
    showError(err);
    append(
      "session.commentary.append",
      "I could not submit that task. Please try again.",
      delegation.id,
    );
  }
}
async function handle(event, call = activeCall) {
  record(event.type, { ...event });
  if (event.type === "session.started") {
    retry = 0;
    status("Listening");
    $("lamp").textContent = "Ready";
    quietJobs();
    memoryContext.flush();
    void flushTranscript();
  } else if (
    [
      "session.input_transcript.delta",
      "session.output_transcript.delta",
    ].includes(event.type)
  )
    transcript(event);
  else if (event.type === "session.delegation.created") void delegate(event);
  else if (event.type === "session.thinking.appended") memoryContext.acknowledge(event.client_event_id);
  else if (event.type === "session.commentary.appended") {
    const delivery = appendAcks.get(event.client_event_id);
    if (delivery) {
      appendAcks.delete(event.client_event_id);
      delivery.remaining.delete(event.client_event_id);
      if (!delivery.remaining.size) {
        void api("/api/delivery", {
          conversation,
          session,
          job: delivery.job,
          event: delivery.event,
          action: "accepted",
        }).catch(showError);
        record("result.context.accepted", { job: delivery.job });
      }
    }
  } else if (event.type === "session.closed") {
    if (wanted) reconnect("remote_session_closed");
    else teardown("user_end");
  } else if (event.type === "error") {
    memoryContext.reject(event.client_event_id || event.error?.event_id);
    connectionError(new Error(event.error?.message || "Voice service error."), call);
  }
}
function monitor(stream, input) {
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(512);
  const context = ac;
  const timer = setInterval(() => {
    if (ac !== context || context.state === "closed") {
      clearInterval(timer);
      return;
    }
    analyser.getFloatTimeDomainData(data);
    let energy = 0;
    for (const n of data) energy += n * n;
    const rms = Math.sqrt(energy / data.length),
      now = Date.now();
    if (input) {
      if (!muted && rms > 0.018) microphoneUntil = now + 500;
    } else if (rms > 0.003) {
      speakerUntil = now + 250;
      lastSpeakerSample = now;
    }
    draw(input ? rms : 0, input ? 0 : rms);
  }, 50);
}
function draw(input, output) {
  const canvas = $("viz"),
    c = canvas.getContext("2d");
  if (canvas.width !== canvas.clientWidth * devicePixelRatio) {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
  }
  const w = canvas.width,
    h = canvas.height;
  c.clearRect(0, 0, w, h);
  c.fillStyle = Date.now() < speakerUntil ? "#ffb454" : "#5b6b82";
  c.beginPath();
  c.arc(
    w / 2,
    h / 2,
    Math.min(w, h) * (0.19 + Math.min(output, 0.15)),
    0,
    Math.PI * 2,
  );
  c.fill();
  c.strokeStyle = Date.now() < microphoneUntil ? "#8eb8ff" : "#344767";
  c.lineWidth = 3;
  c.beginPath();
  c.arc(
    w / 2,
    h / 2,
    Math.min(w, h) * (0.24 + Math.min(input, 0.1)),
    0,
    Math.PI * 2,
  );
  c.stroke();
}
async function deliver() {
  if (deliveryInFlight) {
    const quietAfterAudio =
      lastSpeakerSample > deliveryInFlight.start &&
      Date.now() > speakerUntil + 600;
    if (!quietAfterAudio && Date.now() - deliveryInFlight.start < 15000) return;
    if (!quietAfterAudio)
      record("result.playback.uncertain", { job: deliveryInFlight.job });
    deliveryInFlight = null;
  }
  if (
    !wanted ||
    deliveriesBusy ||
    !session ||
    dc?.readyState !== "open" ||
    Date.now() < Math.max(microphoneUntil, speakerUntil) + 350
  )
    return;
  const job = [...jobs.values()].find(
    (j) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(j.state) &&
      j.delivery === "available" &&
      !offered.has(j.id),
  );
  if (!job) return;
  deliveriesBusy = true;
  try {
    const { offer } = await api("/api/delivery", {
      conversation,
      session,
      job: job.id,
      action: "offer",
    });
    if (!offer) {
      job.delivery = "uncertain";
      return;
    }
    if (dc?.readyState !== "open") {
      await api("/api/delivery", {
        conversation,
        session,
        job: job.id,
        event: offer.event,
        action: "not_sent",
      });
      return;
    }
    offered.add(job.id);
    deliveryInFlight = { job: job.id, start: Date.now() };
    const delegation =
      job.session === session && !job.delegation.startsWith("typed_")
        ? job.delegation
        : null;
    const ids = append(
      "session.commentary.append",
      `A background task ${job.state === "completed" ? "finished" : "ended"}. Tell the user its result briefly at a natural pause, once: ${job.result || job.error}`,
      delegation,
      offer.event,
    );
    const delivery = {
      job: job.id,
      event: offer.event,
      remaining: new Set(ids),
    };
    ids.forEach((id) => appendAcks.set(id, delivery));
    job.delivery = "offered";
    record("result.offered", { job: job.id, event: offer.event });
    // This is only playback evidence. It does not assert that the whole result was heard.
    const start = Date.now();
    const observer = setInterval(() => {
      if (!session || Date.now() - start > 30000) {
        clearInterval(observer);
        return;
      }
      if (lastSpeakerSample > start && Date.now() > speakerUntil + 300) {
        clearInterval(observer);
        void api("/api/delivery", {
          conversation,
          session,
          job: job.id,
          event: offer.event,
          action: "playback_observed",
        }).catch(showError);
      }
    }, 200);
  } catch (err) {
    showError(err);
  } finally {
    deliveriesBusy = false;
  }
}
// Match Hermes's native client: include gathered routes in the one-shot offer.
async function waitForIceGathering(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      peer.removeEventListener("connectionstatechange", changed);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const changed = () => {
      if (["failed", "closed"].includes(peer.connectionState)) {
        cleanup();
        reject(new Error("Voice connection ended before it was ready."));
      } else if (peer.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, 10_000);
    peer.addEventListener("icegatheringstatechange", changed);
    peer.addEventListener("connectionstatechange", changed);
    changed();
  });
}
async function start() {
  if (connecting || closeTimer) return;
  connecting = true;
  wanted = true;
  const epoch = ++connectEpoch;
  let attempt = null;
  const current = () => wanted && epoch === connectEpoch;
  clearTimeout(retryTimer);
  retryTimer = null;
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("settings").disabled = true;
  try {
    status(retry ? "Reconnecting…" : "Connecting…");
    const data = await api("/api/conversations", {
      id: conversation,
      isolated: synthetic,
    });
    if (!current()) return;
    conversation = data.id;
    attempt = telemetry.begin(conversation);
    activeCall = attempt;
    save("jarvis.conversation", conversation);
    data.jobs.forEach(updateJob);
    await flushTranscript();
    if (!current()) return;
    if (!$("chat").children.length)
      for (const turn of data.history.slice(-12)) message(turn.text, turn.role);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: $("noiseSel").value !== "off",
      },
    });
    if (!current()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mic = stream;
    ac = new AudioContext();
    await ac.resume();
    if (!current()) return;
    monitor(mic, true);
    const peer = new RTCPeerConnection();
    pc = peer;
    attempt.peer = peer;
    peer.ontrack = (e) => {
      if (!current()) return;
      const remote = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = remote;
      void audio
        .play()
        .catch(() => connectionError(new Error("Tap Start to allow sound."), attempt));
      monitor(remote, false);
    };
    peer.onconnectionstatechange = () => {
      if (!current()) return;
      record("connection.state", telemetry.states(attempt), attempt);
      if (
        current() &&
        ["failed", "disconnected"].includes(peer.connectionState)
      )
        reconnect(peer.connectionState === "failed" ? "peer_failed" : "peer_disconnected");
    };
    mic.getTracks().forEach((track) => peer.addTrack(track, mic));
    const channel = peer.createDataChannel("oai-events");
    dc = channel;
    attempt.channel = channel;
    channel.onopen = () => {
      if (!current()) return;
      record("connection.open", telemetry.states(attempt), attempt);
      memoryContext.flush();
      void telemetry.sample(attempt);
    };
    channel.onerror = () => {
      if (epoch !== connectEpoch) return;
      record("connection.error", { ...telemetry.states(attempt), errorName: "RTCError", reason: "connection_error" }, attempt);
    };
    channel.onmessage = (e) => {
      if (epoch !== connectEpoch) return;
      try {
        const event = JSON.parse(e.data);
        if (!wanted && event.type !== "session.closed") return;
        void handle(event, attempt).catch(err => connectionError(err, attempt));
      } catch (err) {
        connectionError(err, attempt);
      }
    };
    channel.onclose = () => {
      if (epoch !== connectEpoch) return;
      const reason = wanted ? "remote_channel_closed" : "user_end";
      record("connection.channel.closed", { ...telemetry.states(attempt), requested: !wanted, reason }, attempt);
      if (wanted) reconnect(reason);
      else teardown(reason);
    };
    const offer = await peer.createOffer();
    if (!current()) return;
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    if (!current()) return;
    const result = await api("/api/live", {
      conversation,
      callId: attempt.id,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sdp: peer.localDescription.sdp,
      voice: $("voiceSel").value,
      instructions: $("instructions").value.trim(),
      pace: $("speed").value,
      synthetic,
    });
    telemetry.bind(attempt, result.session.id);
    if (!current()) return;
    session = result.session.id;
    memoryContext.reset(result.memoryModels || []);
    await peer.setRemoteDescription({
      type: "answer",
      sdp: result.transport.sdp,
    });
    if (!current()) return;
    $("muteBtn").disabled = false;
    openEvents();
    setMuted(muted);
    if (!result.memoryReady)
      message(
        "Saved memories are temporarily unavailable. Conversation still works.",
      );
    try {
      const lock = await navigator.wakeLock?.request("screen");
      if (current()) wake = lock;
      else void lock?.release();
    } catch {}
  } catch (err) {
    if (!current()) return;
    connectionError(err, attempt);
    teardown("connection_error");
    if (wanted) {
      retry++;
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          if (wanted && navigator.onLine) void start();
        },
        Math.max(
          err.retryAfterMs || 0,
          Math.min(5000, 500 * 2 ** Math.min(retry, 4)),
        ),
      );
    }
  } finally {
    if (epoch === connectEpoch) connecting = false;
  }
}

function teardown(reason = "unknown") {
  // Capture stats before close without delaying microphone release or reconnect.
  void telemetry.end(activeCall, reason, reason === "user_end" || reason === "close_timeout");
  activeCall = null;
  clearTimeout(closeTimer);
  closeTimer = null;
  connectEpoch++;
  connecting = false;
  source?.close();
  source = null;
  const peer = pc;
  pc = null;
  if (dc) {
    dc.onclose = null;
    dc.close();
    dc = null;
  }
  if (peer) {
    peer.onconnectionstatechange = null;
    peer.close();
  }
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  void ac?.close().catch(() => {});
  ac = null;
  audio.srcObject = null;
  session = null;
  memoryContext.reset();
  appendAcks.clear();
  deliveryInFlight = null;
  lastQuietSnapshot = "";
  offered.clear();
  void wake?.release();
  wake = null;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("muteBtn").disabled = true;
  $("settings").disabled = false;
}
function reconnect(reason = "unknown") {
  if (!wanted || retryTimer) return;
  record("connection.lost", { reason });
  teardown(reason);
  status("Reconnecting — tasks are still running");
  retry++;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      if (wanted && navigator.onLine) void start();
    },
    Math.min(5000, 500 * 2 ** Math.min(retry, 4)),
  );
}
function setMuted(next) {
  muted = next;
  mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  send({
    type: muted ? "session.input_audio.mute" : "session.input_audio.unmute",
    event_id: crypto.randomUUID(),
  });
  $("muteBtn").textContent = muted ? "Unmute" : "Mute";
}
async function typed() {
  const text = $("typeBox").value.trim();
  if (!text) return;
  if (!session) {
    showError(new Error("Start the conversation first."));
    return;
  }
  $("typeBox").value = "";
  const event = {
    type: "session.input_transcript.delta",
    event_id: crypto.randomUUID(),
    delta: text,
    start_ms: Date.now(),
    end_ms: Date.now(),
  };
  transcript(event);
  const result = await api("/api/delegations", {
    conversation,
    session,
    delegation: "typed_" + crypto.randomUUID(),
    events: [event],
  });
  updateJob(result.job);
  append(
    "session.thinking.append",
    `The user typed: ${text}. Hermes is working on it.`,
  );
}
$("startBtn").onclick = () => {
  retryTimer = null;
  void start();
};
$("stopBtn").onclick = () => {
  wanted = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  source?.close();
  source = null;
  mic?.getTracks().forEach((track) => track.stop());
  audio.pause();
  void flushTranscript();
  $("stopBtn").disabled = true;
  $("muteBtn").disabled = true;
  status("Conversation ended. Background tasks remain available.");
  // Match Hermes's native client: allow session.closed before closing transport.
  closeTimer = setTimeout(() => {
    record("connection.close.timeout", { reason: "close_timeout", requested: true });
    teardown("close_timeout");
  }, 15000);
  try {
    if (send({ type: "session.close", event_id: crypto.randomUUID() })) {
      record("connection.close.requested", { reason: "user_end", requested: true });
      return;
    }
  } catch {}
  teardown("user_end");
};
$("muteBtn").onclick = () => setMuted(!muted);
$("sendBtn").onclick = () => void typed().catch(showError);
$("typeBox").onkeydown = (e) => {
  if (e.key === "Enter") void typed().catch(showError);
};
window.addEventListener("online", () => {
  if (wanted && !pc) {
    clearTimeout(retryTimer);
    retryTimer = null;
    void start();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") telemetry.checkpoint(activeCall);
  if (document.visibilityState === "visible" && wanted) {
    void ac?.resume();
    if (!pc) void start();
    else
      navigator.wakeLock
        ?.request("screen")
        .then((x) => {
          wake = x;
        })
        .catch(() => {});
  }
});
// pagehide covers navigation; hidden is the mobile-friendly best-effort checkpoint.
window.addEventListener("pagehide", () => telemetry.checkpoint(activeCall, true));
const audio = document.createElement("audio");
audio.autoplay = true;
audio.setAttribute("playsinline", "");
document.body.append(audio);
const memoryStatus = document.createElement("div");
memoryStatus.className = "meta";
memoryStatus.setAttribute("role", "status");
$("chat").before(memoryStatus);
const taskPanel = document.createElement("section");
taskPanel.hidden = true;
const heading = document.createElement("h2");
heading.textContent = "Your tasks";
const taskList = document.createElement("div");
taskPanel.append(heading, taskList);
$("chat").after(taskPanel);
// GPT-Live accepts role/style instructions and voice at session creation.
// Pace is a prompt preference; the old numeric Realtime controls do not apply.
const personas = {
  assistant: "",
  interviewer: "Conduct a mock interview for a cloud engineering role. Ask one question at a time, listen, then give brief feedback before the next question.",
  tutor: "Be a patient Spanish tutor for a beginner. Speak mostly simple Spanish with brief English help when needed. Gently correct mistakes and ask easy questions.",
  storyteller: "Tell vivid, short fictional stories with expressive delivery. Ask the listener to choose what happens next. Keep invented story details separate from personal memories.",
};
function choices(element, values) {
  element.replaceChildren(...values.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
}
function settingNote(id, text) {
  const note = document.createElement("small");
  note.textContent = text;
  note.id = id + "Help";
  $(id).setAttribute("aria-describedby", note.id);
  $(id).closest(".field").append(note);
  return note;
}
$("settings").querySelector("legend").textContent = "Voice settings";
const settingsNote = document.createElement("small");
settingsNote.textContent = "Choose before Start. To change settings while talking, press End first. Saved in this browser.";
$("settings").querySelector("legend").after(settingsNote);
$("instructions").maxLength = 2000;
$("instructions").placeholder = "Optional: how you want Jarvis to speak or help you.";
settingNote("instructions", "Up to 2,000 characters. Memory and background tasks stay available.");
const paceSelect = document.createElement("select");
paceSelect.id = "speed";
$("speed").replaceWith(paceSelect);
document.querySelector('label[for="speed"]').textContent = "Speaking pace";
choices(paceSelect, [["normal", "Natural"], ["slower", "Slower"], ["faster", "Faster"]]);
settingNote("speed", "A speaking preference; actual pace can vary.");
const timingField = $("patience").closest(".field");
const timingLabel = document.createElement("span");
timingLabel.textContent = "Pause timing";
const timingNote = document.createElement("small");
timingNote.textContent = "Automatic — Jarvis listens for when you finish speaking.";
timingField.replaceChildren(timingLabel, timingNote);
choices($("noiseSel"), [["on", "On"], ["off", "Off"]]);
const noiseSupported = Boolean(navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression);
if (!noiseSupported) {
  choices($("noiseSel"), [["auto", "Managed by this browser"]]);
  $("noiseSel").disabled = true;
}
settingNote("noiseSel", "Uses your browser’s microphone noise reduction. Availability varies by device.");
$("voiceSel").replaceChildren(
  ...[
    "cedar",
    "marin",
    "quartz",
    "ripple",
    "vesper",
    "willow",
    "stone",
    "gleam",
    "meridian",
    "bossa",
    "tempo",
    "beacon",
    "delta",
    "cinder",
  ].map((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    return o;
  }),
);
const preferences = saved("jarvis.settings") || {};
for (const [id, key] of [["personaSel", "persona"], ["voiceSel", "voice"], ["speed", "pace"], ["noiseSel", "noise"]]) {
  if ([...$(id).options].some(option => option.value === preferences[key]))
    $(id).value = preferences[key];
}
$("instructions").value = typeof preferences.instructions === "string"
  ? preferences.instructions.slice(0, 2000)
  : personas[$("personaSel").value] || "";
function savePreferences() {
  try {
    save("jarvis.settings", {
      persona: $("personaSel").value,
      instructions: $("instructions").value,
      voice: $("voiceSel").value,
      pace: $("speed").value,
      noise: $("noiseSel").value,
    });
  } catch {} // Storage restrictions must not stop a voice conversation.
}
$("personaSel").addEventListener("change", () => {
  if (Object.hasOwn(personas, $("personaSel").value))
    $("instructions").value = personas[$("personaSel").value];
  savePreferences();
});
$("instructions").addEventListener("input", () => {
  $("personaSel").value = Object.entries(personas).find(([, text]) => text === $("instructions").value)?.[0] || "custom";
  savePreferences();
});
for (const id of ["voiceSel", "speed", "noiseSel"])
  $(id).addEventListener("change", savePreferences);
document.querySelector("h1").textContent = "Jarvis";
document.querySelector(".eyebrow").textContent = "Your personal assistant";
$("typeBox").placeholder = "Send a task to Hermes";
document.title = "Jarvis";
status("Ready when you are");
draw(0, 0);
setInterval(() => void flushTranscript(), 700);
setInterval(() => void deliver(), 200);
setInterval(async () => {
  const call = activeCall;
  if (call && !call.ended) {
    await telemetry.sample(call);
    if (!call.ended) telemetry.record(call, "call.stats", { ...telemetry.states(call), ...call.stats });
  }
  void telemetry.flush();
}, 5000);
