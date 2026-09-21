// GPT-Live transport follows Hermes's installed voice-live.ts and Microsoft's
// WebRTC/client-delegation guides. Audio interruption never cancels an app job.
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
  muted = false,
  sending = false,
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
window.__voiceLabEvents = [];
function record(type, detail = {}) {
  window.__voiceLabEvents.push({ ts: Date.now(), type, ...detail });
  if (window.__voiceLabEvents.length > 10000)
    window.__voiceLabEvents.splice(0, 1000);
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
let deliveryInFlight = null;
function quietJobs() {
  if (!session) return;
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
    "Silent application state, not a user request. Do not speak, delegate, or repeat completed results because of this update. Use it only if the user asks status. Separate result events request announcements. Task states: " +
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
function openEvents() {
  source?.close();
  source = new EventSource(
    `/api/events?conversation=${encodeURIComponent(conversation)}&auth=${encodeURIComponent(auth)}`,
  );
  source.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "snapshot") event.jobs.forEach(updateJob);
    else if (event.type === "job.updated") updateJob(event.job);
    else if (event.type === "memory.state") {
      const labels = {
        saving: "Saving memories…",
        saved: "Memories saved",
        pending: "Memory save queued — conversation is kept on this server",
      };
      memoryStatus.textContent = labels[event.state] || "";
      if (event.state === "saved")
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
      teardown();
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
async function flushTranscript() {
  if (sending || !conversation || !transcriptQueue.length) return;
  sending = true;
  const first = transcriptQueue[0];
  const group = transcriptQueue
    .filter(
      (x) =>
        x.session === first.session && x.conversation === first.conversation,
    )
    .slice(0, 150);
  try {
    await api("/api/transcript", {
      conversation: first.conversation,
      session: first.session,
      events: group.map((x) => x.event),
    });
    const ids = new Set(group.map((x) => x.id));
    transcriptQueue = transcriptQueue.filter((x) => !ids.has(x.id));
    save("jarvis.transcriptOutbox", transcriptQueue);
  } catch (err) {
    record("transcript.save.pending", { message: err.message });
  } finally {
    sending = false;
  }
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
async function handle(event) {
  record(event.type, { ...event });
  if (event.type === "session.started") {
    retry = 0;
    status("Listening");
    $("lamp").textContent = "Ready";
    quietJobs();
    void flushTranscript();
  } else if (
    [
      "session.input_transcript.delta",
      "session.output_transcript.delta",
    ].includes(event.type)
  )
    transcript(event);
  else if (event.type === "session.delegation.created") void delegate(event);
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
    if (wanted) reconnect();
    else teardown();
  } else if (event.type === "error") {
    showError(new Error(event.error?.message || "Voice service error."));
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
async function start() {
  if (connecting) return;
  connecting = true;
  wanted = true;
  const epoch = ++connectEpoch;
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
        noiseSuppression: true,
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
    peer.ontrack = (e) => {
      if (!current()) return;
      const remote = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = remote;
      void audio
        .play()
        .catch(() => showError(new Error("Tap Start to allow sound.")));
      monitor(remote, false);
    };
    peer.onconnectionstatechange = () => {
      if (
        current() &&
        ["failed", "disconnected"].includes(peer.connectionState)
      )
        reconnect();
    };
    mic.getTracks().forEach((track) => peer.addTrack(track, mic));
    const channel = peer.createDataChannel("oai-events");
    dc = channel;
    channel.onmessage = (e) => {
      if (!current()) return;
      try {
        void handle(JSON.parse(e.data)).catch(showError);
      } catch (err) {
        showError(err);
      }
    };
    channel.onclose = () => {
      if (current()) reconnect();
    };
    const offer = await peer.createOffer();
    if (!current()) return;
    await peer.setLocalDescription(offer);
    const result = await api("/api/live", {
      conversation,
      sdp: peer.localDescription.sdp,
      voice: $("voiceSel").value,
      synthetic,
    });
    if (!current()) return;
    session = result.session.id;
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
    showError(err);
    teardown();
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

function teardown() {
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
function reconnect() {
  if (!wanted || retryTimer) return;
  record("connection.lost");
  teardown();
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
  send({ type: "session.close", event_id: crypto.randomUUID() });
  void flushTranscript();
  teardown();
  status("Conversation ended. Background tasks remain available.");
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
for (const id of [
  "personaSel",
  "instructions",
  "speed",
  "patience",
  "noiseSel",
])
  $(id).closest(".field").hidden = true;
$("settings").querySelector("legend").textContent = "Voice";
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
document.querySelector("h1").textContent = "Jarvis";
document.querySelector(".eyebrow").textContent = "Your personal assistant";
$("typeBox").placeholder = "Send a task to Hermes";
document.title = "Jarvis";
status("Ready when you are");
draw(0, 0);
setInterval(() => void flushTranscript(), 700);
setInterval(() => void deliver(), 200);
