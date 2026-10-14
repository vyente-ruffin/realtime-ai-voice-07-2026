/** Logging gaps found 2026-10-14: each test names the missing evidence path it exercises. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { validateTelemetry } from "../../src/live/telemetry.js";

/** Capture the centralized logger's JSON lines without touching real service logs. */
async function captureLogs(run) {
  const lines = [];
  const out = process.stdout.write, err = process.stderr.write;
  const grab = chunk => { for (const line of String(chunk).split("\n")) if (line.startsWith("{")) lines.push(JSON.parse(line)); return true; };
  process.stdout.write = grab;
  process.stderr.write = grab;
  try { await run(); } finally { process.stdout.write = out; process.stderr.write = err; }
  return lines;
}

/** Same isolated fixture as observability.test.mjs: real HTTP, validation and SQLite. */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-logging-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const path = join(dir, "state.sqlite");
  const config = join(dir, "memory.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://127.0.0.1:1", bank_id: "synthetic" }));
  const child = spawn(process.execPath, ["tests/live/server-fixture.mjs"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VOICE_STATE_PATH: path,
      APPLICATIONINSIGHTS_CONNECTION_STRING: "", VOICE_QUALIFICATION: "1",
      AZURE_OPENAI_ENDPOINT: "https://synthetic.invalid", AZURE_OPENAI_DEPLOYMENT_NAME: "test",
      HINDSIGHT_CONFIG_PATH: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  child.stdout.on("data", b => { output.text += b; });
  child.stderr.on("data", b => { output.text += b; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + "/healthz")).ok; } catch {}
    if (ready || child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ready, output.text);
  const token = (await (await fetch(base + "/auth-refresh")).json()).token;
  const post = (route, body) => fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Auth": token },
    body: JSON.stringify(body),
  });
  const conversation = (await (await post("/api/conversations", { isolated: true })).json()).id;
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  const logs = () => output.text.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
  return { post, conversation, db, base, logs, path };
}

async function waitFor(read, label, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("gap: telemetry schema accepts stage, mic, playback, provider error and close fields, rejects free text", () => {
  const base = { id: "e1", conversation: "c", session: "s", callId: "k", ts: 1 };
  const good = [
    { ...base, type: "connection.error", detail: { errorName: "NotAllowedError", reason: "connection_error", stage: "microphone" } },
    { ...base, type: "connection.microphone", detail: { microphoneState: "ended" } },
    { ...base, type: "connection.playback", detail: { playbackState: "blocked", errorName: "NotAllowedError" } },
    ...["paused", "stalled", "ended"].map(playbackState => ({ ...base, type: "connection.playback", detail: { playbackState } })),
    { ...base, type: "connection.error", detail: { stage: "provider", providerErrorType: "invalid_request_error", providerErrorCode: "invalid_audio", commandCorrelated: true } },
    { ...base, type: "connection.session.started", detail: {} },
    { ...base, type: "connection.session.closed", detail: { providerCloseReason: "expired" } },
    { ...base, type: "connection.updates.lost", detail: {} },
    { ...base, type: "telemetry.gap", detail: { droppedEvents: 3, failedFlushes: 2, beaconRefused: 1 } },
    { ...base, type: "call.stats", detail: { microphoneState: "live", playbackState: "playing", audioContextState: "running" } },
  ];
  assert.equal(validateTelemetry(good, "c").length, good.length);
  for (const detail of [{ stage: "anything" }, { providerErrorCode: "PCM16 audio must contain" }, { providerErrorType: "x".repeat(101) },
    { playbackState: "heard" }, { providerCloseReason: "because" }, { microphoneState: "Built-in Microphone" }])
    assert.throws(() => validateTelemetry([{ ...base, type: "connection.error", detail }], "c"), /Invalid telemetry/);
});

test("gap: browser states include microphone, playback and AudioContext state without device labels", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  const telemetry = new BrowserTelemetry({ post: async () => {}, beacon: () => true });
  const call = telemetry.begin("c");
  call.microphone = { readyState: "live", enabled: true, muted: false, label: "PRIVATE_DEVICE_LABEL" };
  call.audioContext = { state: "suspended" };
  call.playbackState = "playing";
  assert.deepEqual(telemetry.states(call), { microphoneState: "live", playbackState: "playing", audioContextState: "suspended" });
  call.microphone.muted = true;
  assert.equal(telemetry.states(call).microphoneState, "muted");
  call.microphone.enabled = false;
  assert.equal(telemetry.states(call).microphoneState, "disabled");
  call.microphone.readyState = "ended";
  assert.equal(telemetry.states(call).microphoneState, "ended");
  assert.doesNotMatch(JSON.stringify(telemetry.states(call)), /PRIVATE_DEVICE_LABEL/);
});

test("gap: dropped events, failed flushes and refused beacons are reported once delivery recovers", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  let fail = true;
  const sent = [];
  const telemetry = new BrowserTelemetry({ post: async body => { if (fail) throw new Error("offline"); sent.push(body); },
    beacon: () => false });
  const call = telemetry.begin("c");
  telemetry.bind(call, "live-1");
  for (let i = 0; i < 120; i++) telemetry.record(call, "connection.state");
  await telemetry.flush();
  await telemetry.flush();
  telemetry.checkpoint(call);
  fail = false;
  await telemetry.flush();
  const events = sent.flatMap(body => body.events);
  const gap = events.find(e => e.type === "telemetry.gap");
  assert.ok(gap, "a recovered outage must leave evidence of its own loss");
  assert.equal(gap.callId, call.id);
  assert.equal(gap.session, "live-1");
  assert.equal(gap.detail.droppedEvents, 22); // 1 start + 120 states + 1 hidden checkpoint, bounded at 100
  assert.equal(gap.detail.failedFlushes, 2);
  assert.equal(gap.detail.beaconRefused, 1);
  assert.equal(telemetry.queue.length, 0);
  validateTelemetry([gap], "c");
  sent.length = 0;
  telemetry.record(call, "connection.state");
  await telemetry.flush();
  assert.equal(sent.flatMap(b => b.events).filter(e => e.type === "telemetry.gap").length, 0, "counters reset after reporting");
});

test("gap: telemetry loss is reported under the call that lost it, never blamed on a newer call", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  let fail = true;
  const sent = [];
  const telemetry = new BrowserTelemetry({ post: async body => { if (fail) throw new Error("offline"); sent.push(body); },
    beacon: () => true });
  const a = telemetry.begin("c");
  telemetry.bind(a, "live-a");
  for (let i = 0; i < 50; i++) telemetry.record(a, "connection.state");
  await telemetry.flush(); // fails with only call A's events in the batch
  const b = telemetry.begin("c");
  telemetry.bind(b, "live-b");
  for (let i = 0; i < 100; i++) telemetry.record(b, "connection.state"); // pushes A's 51 events and B's start out
  await telemetry.flush(); // fails with only call B's events in the batch
  fail = false;
  await telemetry.flush();
  const events = sent.flatMap(body => body.events);
  const gaps = events.filter(e => e.type === "telemetry.gap");
  assert.deepEqual(gaps.map(g => g.callId).sort(), [a.id, b.id].sort(), "one gap per call that lost evidence");
  const gapA = gaps.find(g => g.callId === a.id), gapB = gaps.find(g => g.callId === b.id);
  assert.equal(gapA.session, "live-a");
  assert.deepEqual(gapA.detail, { droppedEvents: 51, failedFlushes: 1, beaconRefused: 0 });
  assert.equal(gapB.session, "live-b");
  assert.deepEqual(gapB.detail, { droppedEvents: 1, failedFlushes: 1, beaconRefused: 0 });
  assert.equal(new Set(events.map(e => e.id)).size, events.length, "no event is sent twice");
  validateTelemetry(gaps, "c");
});

test("gap: rejected Azure session keeps provider status and request id, without changing the HTTP mapping", async t => {
  const { AzureLive } = await import("../../src/live/azure.js");
  const azure = new AzureLive({ endpoint: "https://synthetic.invalid", deployment: "d", subscription: "s" });
  azure.accessToken = async () => "synthetic-test-only";
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response("{}", { status: 503, headers: { "apim-request-id": "req-123" } });
  const lines = await captureLogs(async () => {
    const err = await azure.session({ sdp: "v=0", voice: "cedar", instructions: "", history: [] }).catch(e => e);
    assert.equal(err.providerStatus, 503);
    assert.equal(err.providerRequestId, "req-123");
    assert.equal(err.status, undefined, "server still answers 502 for provider failures");
  });
  assert.equal(lines.find(l => l.message === "Azure session rejected").providerRequestId, "req-123");
  globalThis.fetch = async () => Response.json({ session: { id: "sess_1" }, transport: { sdp: "v=0" } }, { headers: { "x-request-id": "req-ok" } });
  assert.equal((await azure.session({ sdp: "v=0", voice: "cedar", instructions: "", history: [] })).requestId, "req-ok");
});

test("gap: failed and started voice sessions are audited and logged with the browser call id", async t => {
  const { post, conversation, db, logs } = await fixture(t);
  const failed = await post("/api/live", { conversation, sdp: "v=0 synthetic-fail", callId: "call-fail" });
  assert.equal(failed.status, 502);
  const row = db.prepare("SELECT payload FROM audit WHERE kind='session.failed'").get();
  assert.ok(row, "a failed connection attempt needs durable server evidence");
  const payload = JSON.parse(row.payload);
  assert.equal(payload.callId, "call-fail");
  assert.equal(payload.providerStatus, 503);
  assert.equal(payload.providerRequestId, "synthetic-request");
  assert.equal(typeof payload.connectionMs, "number");
  assert.doesNotMatch(row.payload, /v=0/);
  await post("/api/live", { conversation, sdp: "v=0", callId: "call-ok" });
  const lines = await waitFor(() => logs().some(l => l.message === "Voice session started") && logs(), "start log");
  const started = lines.find(l => l.message === "Voice session started");
  assert.equal(started.trace_id, "call-ok");
  assert.equal(started.conversation, conversation);
  assert.ok(started.session);
  assert.equal(lines.find(l => l.message === "Voice session failed").trace_id, "call-fail");
});

test("gap: playback observation is correlated to its session and accepts only a bounded event id", async t => {
  const { post, conversation, db, path } = await fixture(t);
  const live = await (await post("/api/live", { conversation, sdp: "v=0", callId: "call-1" })).json();
  const { VoiceStore } = await import("../../src/live/store.js");
  const store = new VoiceStore(path);
  const job = store.enqueue(conversation, live.session.id, "d-1", "user: hello");
  store.updateJob(job.id, "completed", { result: "synthetic" });
  store.close();
  for (const event of ["PRIVATE_SPEECH_SENTINEL and other free text", "x".repeat(101), 42, null]) {
    const refused = await post("/api/delivery", { conversation, session: live.session.id, job: job.id, event, action: "playback_observed" });
    assert.equal(refused.status, 400, `event ${JSON.stringify(event)} must be refused`);
    assert.equal(refused.headers.get("content-type"), "application/problem+json");
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE kind='result.playback_observed'").get().n, 0, "refused events save nothing");
  const response = await post("/api/delivery", { conversation, session: live.session.id, job: job.id, event: "result_0f1e2d3c-aaaa-bbbb-cccc-123456789abc", action: "playback_observed" });
  assert.equal(response.status, 200);
  const row = JSON.parse(db.prepare("SELECT payload FROM audit WHERE kind='result.playback_observed'").get().payload);
  assert.equal(row.session, live.session.id);
  assert.equal(row.job, job.id);
  assert.equal(row.event, "result_0f1e2d3c-aaaa-bbbb-cccc-123456789abc");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE payload LIKE '%PRIVATE_%'").get().n, 0);
});

test("gap: background task transitions are logged with conversation and session correlation", async t => {
  const { VoiceStore } = await import("../../src/live/store.js");
  const { VoiceWorker } = await import("../../src/live/worker.js");
  const dir = mkdtempSync(join(tmpdir(), "voice-logging-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => store.close());
  const c = store.createConversation();
  const job = store.enqueue(c.id, "sess-1", "d-1", "user: PRIVATE_REQUEST_SENTINEL");
  const worker = new VoiceWorker({ store, onUpdate() {}, key: "k", baseUrl: "http://hermes.test", retryMs: 10,
    recall: async () => "", fetch: async (url, init = {}) => {
      if (init.method === "POST") return Response.json({ run_id: "run_1" }, { status: 202 });
      if (url.includes("/events")) return new Response('data: {"event":"run.completed","output":"PRIVATE_RESULT_SENTINEL","seq":0}\n\n');
      return Response.json({ status: "completed", output: "PRIVATE_RESULT_SENTINEL" });
    } });
  const lines = await captureLogs(() => worker.kick());
  const states = lines.filter(l => l.message === "Background task state");
  assert.deepEqual(states.map(l => l.state), ["running", "completed"]);
  for (const line of states) {
    assert.equal(line.id, job.id);
    assert.equal(line.conversation, c.id);
    assert.equal(line.session, "sess-1");
    assert.equal(typeof line.ageMs, "number");
  }
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_(REQUEST|RESULT)_SENTINEL/);
  const second = store.enqueue(c.id, "sess-1", "d-2", "user: other");
  const cancelled = await captureLogs(async () => worker.cancel(store.job(second.id)));
  assert.equal(cancelled.find(l => l.message === "Background task state").state, "cancelled");
});

test("gap: failed memory saves and degraded prepared summaries are warned with ids only", async t => {
  const { VoiceMemory } = await import("../../src/live/memory.js");
  const dir = mkdtempSync(join(tmpdir(), "voice-logging-memory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "memory.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://127.0.0.1:1", bank_id: "synthetic" }));
  const store = { cache: () => null, putCache() {}, queueMemory() {}, memoryState() {}, memorySaveStatus: () => "saved",
    pendingMemory: () => ({ id: "m1", conversation: "c1", state: "submitted", operation: "op1", attempts: 0, content: "PRIVATE_MEMORY_SENTINEL" }) };
  const memory = new VoiceMemory({ configPath: config, store, modelIds: ["profile", "preferences"] });
  memory.request = async () => ({ status: "failed" });
  let lines = await captureLogs(() => memory.drain());
  const failed = lines.find(l => l.message === "Memory save failed");
  assert.ok(failed, "a Hindsight extraction failure must reach the service log");
  assert.equal(failed.level, "warn");
  assert.equal(failed.id, "m1");
  assert.equal(failed.conversation, "c1");
  memory.request = async () => ({ status: "completed" });
  lines = await captureLogs(() => memory.drain());
  assert.ok(lines.find(l => l.message === "Memory save completed" && l.id === "m1"));
  memory.request = async path => path.endsWith("/profile") ? { id: "profile", content: "PRIVATE_MEMORY_SENTINEL" } : Promise.reject(new Error("down"));
  lines = await captureLogs(() => memory.refresh());
  const degraded = lines.find(l => l.message === "Prepared memories loaded");
  assert.equal(degraded.level, "warn");
  assert.deepEqual(degraded.failedModels, ["preferences"]);
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_MEMORY_SENTINEL/);
});

test("gap: a failed first memory send is warned with conversation, stage and bounded error ids, never raw error text", async t => {
  const { VoiceMemory } = await import("../../src/live/memory.js");
  const dir = mkdtempSync(join(tmpdir(), "voice-logging-memory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "memory.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://127.0.0.1:1", bank_id: "synthetic" }));
  const store = { cache: () => null, putCache() {}, queueMemory() {}, memoryState() {}, memorySaveStatus: () => "saving",
    pendingMemory: () => ({ id: "m2", conversation: "c2", state: "pending", operation: "op2", attempts: 2, content: "PRIVATE_MEMORY_SENTINEL" }) };
  const memory = new VoiceMemory({ configPath: config, store, modelIds: ["profile"] });
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  // A refused connection: undici's message and cause name the host, which must not reach the log.
  globalThis.fetch = async () => { throw new TypeError("fetch failed PRIVATE_HOST_SENTINEL",
    { cause: Object.assign(new Error("connect ECONNREFUSED PRIVATE_HOST_SENTINEL:8888"), { code: "ECONNREFUSED" }) }); };
  let lines = await captureLogs(() => memory.drain());
  let pending = lines.find(l => l.message === "Memory save pending");
  assert.ok(pending, "a failed send must reach the service log");
  assert.equal(pending.level, "warn");
  assert.equal(pending.id, "m2");
  assert.equal(pending.conversation, "c2");
  assert.equal(pending.stage, "send");
  assert.equal(pending.errorName, "TypeError");
  assert.equal(pending.errorCode, "ECONNREFUSED");
  assert.equal(pending.httpStatus, null);
  assert.equal(pending.attempts, 3);
  assert.equal(pending.error, undefined, "no raw error text field");
  globalThis.fetch = async () => new Response("PRIVATE_BODY_SENTINEL", { status: 503 });
  lines = lines.concat(await captureLogs(() => memory.drain()));
  pending = lines.filter(l => l.message === "Memory save pending").at(-1);
  assert.equal(pending.httpStatus, 503);
  assert.equal(pending.errorName, "Error");
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_(HOST|MEMORY|BODY)_SENTINEL|127\.0\.0\.1/);
});

/** Real app, HTTP and SQLite; only the provider WebRTC peer is simulated. */
async function browserPage(t, base, { blockPlay = false, denyMic = false } = {}) {
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(({ blockPlay, denyMic }) => {
    if (blockPlay) {
      // An autoplay policy block stops both play() and the autoplay attribute.
      HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
      Object.defineProperty(HTMLMediaElement.prototype, "autoplay", { get: () => false, set() {} });
    }
    if (denyMic) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    // Native classes, only remembered so a test can drive their real state changes.
    const NativeAudioContext = window.AudioContext, NativeEventSource = window.EventSource;
    window.testContexts = [];
    window.testSources = [];
    window.AudioContext = class extends NativeAudioContext { constructor(...a) { super(...a); window.testContexts.push(this); } };
    window.EventSource = class extends NativeEventSource { constructor(...a) { super(...a); window.testSources.push(this); } };
    window.RTCPeerConnection = class extends EventTarget {
      constructor() { super(); window.testPeer = this; this.connectionState = "new"; this.iceConnectionState = "new"; this.iceGatheringState = "complete"; }
      addTrack(track) { window.testMicTrack = track; }
      createDataChannel() { this.channel = { readyState: "connecting", send() {}, close() { this.readyState = "closed"; } }; return this.channel; }
      async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() {
        this.connectionState = "connected"; this.iceConnectionState = "connected";
        this.channel.readyState = "open";
        this.channel.onopen?.(); this.onconnectionstatechange?.();
        // A real remote audio track, so HTMLMediaElement.play() runs natively.
        const audio = new AudioContext();
        const destination = audio.createMediaStreamDestination();
        audio.createOscillator().connect(destination);
        this.ontrack?.({ streams: [destination.stream], track: destination.stream.getAudioTracks()[0] });
      }
      async getStats() { return new Map(); }
      close() { this.connectionState = "closed"; }
    };
  }, { blockPlay, denyMic });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/?synthetic=1");
  return { page, errors };
}

const rows = (db, kind) => db.prepare("SELECT payload FROM audit WHERE kind=? ORDER BY id").all(kind).map(r => JSON.parse(r.payload));

test("gap (browser): mic ready/ended, playback started, provider session lifecycle and errors reach the audit", async t => {
  const { base, db } = await fixture(t);
  const { page, errors } = await browserPage(t, base);
  await page.click("#startBtn");
  await page.waitForFunction(() => window.testPeer?.channel.readyState === "open");
  const mic = await waitFor(() => rows(db, "connection.microphone")[0], "microphone ready");
  assert.equal(mic.detail.microphoneState, "live");
  const playback = await waitFor(() => rows(db, "connection.playback").find(r => r.detail.playbackState === "playing"), "playback started");
  assert.ok(rows(db, "connection.playback").some(r => r.detail.playbackState === "track_received"));
  assert.equal(playback.callId, mic.callId);
  assert.equal(rows(db, "connection.error").length, 0, "successful playback is not an error");
  await page.evaluate(() => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: "session.started", session: { id: "x", instructions: "PRIVATE_PROMPT_SENTINEL" } }) }));
  await waitFor(() => rows(db, "connection.session.started")[0], "provider session start");
  await page.evaluate(() => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: "error",
    error: { type: "invalid_request_error", code: "invalid_value", message: "PRIVATE_ERROR_SENTINEL", param: "content", client_event_id: "evt_1" } }) }));
  const provider = await waitFor(() => rows(db, "connection.error").find(r => r.detail.stage === "provider"), "provider error");
  assert.equal(provider.detail.providerErrorType, "invalid_request_error");
  assert.equal(provider.detail.providerErrorCode, "invalid_value");
  assert.equal(provider.detail.commandCorrelated, true);
  // Media Capture spec "track ended": the browser sets readyState to "ended", then fires "ended".
  // Chromium's fake device cannot be unplugged and stop() fires no event, so reproduce that order.
  await page.evaluate(() => {
    Object.defineProperty(window.testMicTrack, "readyState", { value: "ended" });
    window.testMicTrack.dispatchEvent(new Event("ended"));
  });
  await waitFor(() => rows(db, "connection.microphone").find(r => r.detail.microphoneState === "ended"), "microphone ended");
  await page.click("#stopBtn");
  await page.evaluate(() => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 3 } }) }));
  const closed = await waitFor(() => rows(db, "connection.session.closed")[0], "provider close reason");
  assert.equal(closed.detail.providerCloseReason, "close_requested");
  const ended = await waitFor(() => rows(db, "call.ended")[0], "call ended");
  assert.equal(ended.detail.playbackState, "playing");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE payload LIKE '%PRIVATE_%'").get().n, 0);
  assert.deepEqual(errors, []);
});

test("gap (browser): blocked playback and microphone denial are named with their stage", async t => {
  const { base, db } = await fixture(t);
  const blocked = await browserPage(t, base, { blockPlay: true });
  await blocked.page.click("#startBtn");
  const state = await waitFor(() => rows(db, "connection.playback").find(r => r.detail.playbackState === "blocked"), "blocked playback");
  assert.equal(state.detail.errorName, "NotAllowedError");
  const error = await waitFor(() => rows(db, "connection.error").find(r => r.detail.stage === "playback"), "playback error");
  assert.equal(error.detail.errorName, "NotAllowedError");
  assert.ok(!rows(db, "connection.playback").some(r => r.detail.playbackState === "playing"));
  await blocked.page.click("#stopBtn");
  const denied = await browserPage(t, base, { denyMic: true });
  await denied.page.click("#startBtn");
  const mic = await waitFor(() => rows(db, "connection.error").find(r => r.detail.stage === "microphone"), "microphone denial");
  assert.equal(mic.detail.errorName, "NotAllowedError");
  // After a failed start the app waits to retry with End disabled; closing the page ends the retries.
  await denied.page.close();
});

/** A real SQLite failure inside the server's own write: a trigger aborts chosen audit kinds. */
function failAudits(path, kinds, when = `NEW.kind IN (${kinds.map(k => `'${k}'`).join(",")})`) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN ${when}
    BEGIN SELECT RAISE(ABORT, 'PRIVATE_SQLITE_SENTINEL'); END;`);
  return () => { db.exec("DROP TRIGGER fail_audit"); db.close(); };
}

test("gap: a telemetry batch that cannot be persisted answers 503, saves nothing partial and is logged without the batch", async t => {
  const { post, conversation, db, logs, path } = await fixture(t);
  const base = { conversation, session: null, callId: "call-a", ts: 1 };
  const events = [
    { ...base, id: "e1", type: "connection.state", detail: { connectionState: "connected" } },
    { ...base, id: "e2", type: "connection.playback", detail: { playbackState: "playing" } },
  ];
  const restore = failAudits(path, ["connection.playback"]);
  const failed = await post("/api/telemetry", { conversation, events });
  assert.equal(failed.status, 503, "the browser must keep the batch and count the failed flush");
  assert.equal(failed.headers.get("content-type"), "application/problem+json");
  assert.doesNotMatch(await failed.text(), /PRIVATE_SQLITE_SENTINEL|SQLITE/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE kind LIKE 'connection.%'").get().n, 0, "no partial batch");
  const line = await waitFor(() => logs().find(l => l.message === "Voice audit write failed"), "audit failure log");
  assert.equal(line.level, "warn");
  assert.equal(line.conversation, conversation);
  assert.equal(line.kind, "telemetry");
  assert.equal(line.events, 2);
  assert.equal(line.trace_id, "call-a");
  assert.equal(typeof line.errorCode, "string");
  assert.doesNotMatch(JSON.stringify(logs()), /PRIVATE_SQLITE_SENTINEL/);
  restore();
  const retried = await post("/api/telemetry", { conversation, events });
  assert.equal(retried.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE kind LIKE 'connection.%'").get().n, 2, "retry saves each event once");
});

test("gap: an audit write failure after Azure accepted the session does not fail the call, and is logged", async t => {
  const { post, conversation, logs, path } = await fixture(t);
  const restore = failAudits(path, ["session.started", "session.failed"]);
  t.after(restore);
  const started = await post("/api/live", { conversation, sdp: "v=0", callId: "call-ok" });
  assert.equal(started.status, 200, "a working call must not be reported as failed because its audit row was not saved");
  const failed = await post("/api/live", { conversation, sdp: "v=0 synthetic-fail", callId: "call-fail" });
  assert.equal(failed.status, 502, "the provider failure, not the audit failure, is reported");
  assert.match((await failed.json()).title, /Azure could not start voice/);
  const lines = await waitFor(() => logs().filter(l => l.message === "Voice audit write failed").length >= 2 && logs(), "audit failure logs");
  const failures = lines.filter(l => l.message === "Voice audit write failed");
  assert.deepEqual(failures.map(l => l.kind).sort(), ["session.failed", "session.started"]);
  assert.deepEqual(failures.map(l => l.trace_id).sort(), ["call-fail", "call-ok"]);
  assert.ok(lines.some(l => l.message === "Voice session started" && l.trace_id === "call-ok"));
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE_SQLITE_SENTINEL/);
});

test("gap (browser): paused, stalled and ended playback after start are recorded as element states only", async t => {
  const { base, db } = await fixture(t);
  const { page, errors } = await browserPage(t, base);
  await page.click("#startBtn");
  const playing = await waitFor(() => rows(db, "connection.playback").find(r => r.detail.playbackState === "playing"), "playback started");
  const states = () => rows(db, "connection.playback").filter(r => r.callId === playing.callId).map(r => r.detail.playbackState);
  // Native HTMLMediaElement pause, then resume.
  await page.evaluate(() => document.querySelector("body > audio").pause());
  await waitFor(() => states().includes("paused"), "paused playback");
  await page.evaluate(() => document.querySelector("body > audio").play());
  await waitFor(() => states().filter(s => s === "playing").length >= 2, "resumed playback");
  // A live MediaStream never naturally stalls in a fake-device harness; the element event is what we observe.
  await page.evaluate(() => document.querySelector("body > audio").dispatchEvent(new Event("stalled")));
  await waitFor(() => states().includes("stalled"), "stalled playback");
  await page.evaluate(() => document.querySelector("body > audio").dispatchEvent(new Event("ended")));
  await waitFor(() => states().includes("ended"), "ended playback");
  assert.deepEqual(states(), ["track_received", "playing", "paused", "playing", "stalled", "ended"]);
  // User stop pauses the element on purpose; that is not a playback fault.
  await page.click("#stopBtn");
  await page.evaluate(() => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: "session.closed", reason: "close_requested" }) }));
  const ended = await waitFor(() => rows(db, "call.ended")[0], "call ended");
  assert.equal(ended.detail.playbackState, "ended");
  assert.equal(states().filter(s => s === "paused").length, 1);
  assert.deepEqual(errors, []);
});

test("gap (browser): microphone mute/unmute, lost task updates and mid-call AudioContext changes reach the audit", async t => {
  const { base, db } = await fixture(t);
  const { page, errors } = await browserPage(t, base);
  await page.click("#startBtn");
  await page.waitForFunction(() => window.testPeer?.channel.readyState === "open");
  const live = await waitFor(() => rows(db, "connection.microphone")[0], "microphone ready");
  const mic = () => rows(db, "connection.microphone").filter(r => r.callId === live.callId).map(r => r.detail.microphoneState);
  // Media Capture spec: the UA sets track.muted, then fires mute/unmute. Chromium's fake device never
  // mutes on its own, so reproduce that order on the app's real track.
  for (const [muted, type] of [[true, "mute"], [false, "unmute"]])
    await page.evaluate(([muted, type]) => {
      Object.defineProperty(window.testMicTrack, "muted", { configurable: true, value: muted });
      window.testMicTrack.dispatchEvent(new Event(type));
    }, [muted, type]);
  await waitFor(() => mic().join() === "live,muted,live", "muted then live again");
  // Task/memory updates: wait for the real stream to open, then deliver the browser's error event.
  await page.waitForFunction(() => window.testSources.at(-1)?.readyState === EventSource.OPEN);
  const opened = await page.evaluate(() => window.testSources.length);
  await page.evaluate(() => window.testSources.at(-1).dispatchEvent(new Event("error")));
  const lost = await waitFor(() => rows(db, "connection.updates.lost")[0], "update stream lost");
  assert.equal(lost.callId, live.callId);
  await page.waitForFunction(n => window.testSources.length > n && window.testSources.at(-1).readyState === EventSource.OPEN, opened);
  // Native AudioContext suspend/resume in the middle of the call.
  const audio = () => rows(db, "connection.audio_context").filter(r => r.callId === live.callId).map(r => r.detail.audioContextState);
  await page.evaluate(() => window.testContexts[0].suspend());
  await waitFor(() => audio().includes("suspended"), "AudioContext suspended");
  await page.evaluate(() => window.testContexts[0].resume());
  await waitFor(() => audio().lastIndexOf("running") > audio().indexOf("suspended"), "AudioContext running again");
  // End of call: the AudioContext close during teardown is not recorded as a mid-call change.
  await page.click("#stopBtn");
  await page.evaluate(() => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: "session.closed", reason: "close_requested" }) }));
  await waitFor(() => rows(db, "call.ended")[0], "call ended");
  assert.ok(!audio().includes("closed"));
  assert.equal(rows(db, "connection.updates.lost").length, 1, "one loss, recorded once");
  assert.deepEqual(errors, []);
});

test("gap (browser): telemetry the server cannot save (503) is retried by the browser and saved once, with a telemetry.gap", async t => {
  const { base, db, logs, path } = await fixture(t);
  // A real SQLite failure for every browser telemetry kind; the server's own session rows are unaffected.
  const restore = failAudits(path, [], "NEW.kind LIKE 'connection.%' OR NEW.kind IN ('call.stats', 'call.ended', 'telemetry.gap')");
  let restored = false;
  t.after(() => { if (!restored) restore(); });
  const { page, errors } = await browserPage(t, base);
  await page.click("#startBtn");
  await page.waitForFunction(() => window.testPeer?.channel.readyState === "open");
  const refused = await waitFor(() => logs().find(l => l.message === "Voice audit write failed" && l.kind === "telemetry"), "503 for a telemetry batch");
  assert.equal(rows(db, "connection.started").length, 0, "nothing saved while the store refuses");
  restore();
  restored = true;
  // The browser's own periodic flush (5 s) or the next connection event retries the kept batch.
  const gap = await waitFor(() => rows(db, "telemetry.gap")[0], "telemetry.gap after recovery", 12000);
  const started = rows(db, "connection.started");
  assert.equal(started.length, 1, "the retried start event is saved exactly once");
  assert.equal(gap.callId, started[0].callId);
  assert.equal(refused.trace_id, started[0].callId);
  assert.ok(gap.detail.failedFlushes >= 1);
  assert.equal(gap.detail.droppedEvents, 0);
  assert.equal(rows(db, "telemetry.gap").length, 1, "one gap report for the one outage");
  const ids = db.prepare("SELECT json_extract(payload, '$.id') id FROM audit WHERE json_extract(payload, '$.callId') = ?").all(gap.callId).map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, "no browser event is persisted twice");
  assert.doesNotMatch(JSON.stringify(logs()), /PRIVATE_SQLITE_SENTINEL/);
  await page.click("#stopBtn");
  assert.deepEqual(errors, []);
});
