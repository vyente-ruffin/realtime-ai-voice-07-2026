/** Send audit: every append the page sends to GPT-Live, and every acknowledgment of one, leaves an
 * audit row for its conversation, session and call with a purpose label and content length, never
 * the content text. Real app, HTTP and SQLite; only the provider WebRTC peer is simulated. */
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

/** 1 s of 48 kHz mono PCM16 silence: the fake microphone must not look like the user talking. */
function silentWav(dir) {
  const samples = 48000, data = Buffer.alloc(samples * 2), header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  const file = join(dir, "silence.wav");
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-sends-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
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
  let output = "";
  child.stdout.on("data", (b) => { output += b; });
  child.stderr.on("data", (b) => { output += b; });
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
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(base + "/healthz")).ok; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(ready, output);
  const token = (await (await fetch(base + "/auth-refresh")).json()).token;
  const conversation = (await (await fetch(base + "/api/conversations", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Auth": token },
    body: JSON.stringify({ isolated: true }),
  })).json()).id;
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  return { base, conversation, db, dir };
}

async function waitFor(read, label, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function page(t, base, conversation, dir) {
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${silentWav(dir)}`, "--autoplay-policy=no-user-gesture-required"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript((id) => {
    localStorage.setItem("jarvis.conversation", JSON.stringify(id));
    window.testSent = [];
    window.testSources = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource { constructor(...a) { super(...a); window.testSources.push(this); } };
    window.RTCPeerConnection = class extends EventTarget {
      constructor() { super(); window.testPeer = this; this.connectionState = "new"; this.iceConnectionState = "new"; this.iceGatheringState = "complete"; }
      addTrack() {}
      createDataChannel() {
        this.channel = { readyState: "connecting", send: (text) => window.testSent.push(JSON.parse(text)), close() { this.readyState = "closed"; } };
        return this.channel;
      }
      async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() {
        this.connectionState = "connected"; this.iceConnectionState = "connected";
        this.channel.readyState = "open";
        this.channel.onopen?.(); this.onconnectionstatechange?.();
      }
      async getStats() { return new Map(); }
      close() { this.connectionState = "closed"; }
    };
  }, conversation);
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base + "/?synthetic=1");
  return { page: p, errors };
}

const appends = (p) => p.evaluate(() => window.testSent.filter((e) => /^session\.(thinking|commentary|instructions)\.append$/.test(e.type)));
const event = (p, e) => p.evaluate((x) => window.testPeer.channel.onmessage({ data: JSON.stringify(x) }), e);
const say = (p, delta, startMs) => event(p, { type: "session.input_transcript.delta", event_id: `u${startMs}`, delta, start_ms: startMs, end_ms: startMs + 400 });
const rows = (db, kind) => db.prepare("SELECT conversation,payload FROM audit WHERE kind=? ORDER BY id").all(kind).map((r) => ({ conversation: r.conversation, ...JSON.parse(r.payload) }));
const sentWith = async (p, purposeText) => (await appends(p)).find((e) => purposeText.test(e.content));

test("send audit: the schema accepts send/ack rows and rejects content text or unknown purposes", () => {
  const base = { id: "e1", conversation: "c", session: "s", callId: "k", ts: 1 };
  const good = [
    { ...base, type: "model.send", detail: { eventType: "session.commentary.append", eventId: "result_1_0", delegationId: "item_1", purpose: "result", contentLength: 42, sentAt: 5 } },
    { ...base, type: "model.ack", detail: { eventType: "session.commentary.appended", eventId: "result_1_0", delegationId: null, purpose: "result", ackAt: 6, sentAt: 5, ackMs: 1 } },
    { ...base, type: "model.rejected", detail: { eventId: "x_0", delegationId: null, purpose: "unknown", ackAt: 6 } },
  ];
  assert.equal(validateTelemetry(good, "c").length, 3);
  for (const detail of [{ content: "PRIVATE" }, { purpose: "gossip" }, { eventType: "session.close" }, { eventId: "has spaces" }, { contentLength: -1 }])
    assert.throws(() => validateTelemetry([{ ...base, type: "model.send", detail }], "c"), /Invalid telemetry/);
});

test("send audit: every send path records a row with its purpose, length, ids and call; every ack records its time", async (t) => {
  const { base, conversation, db, dir } = await fixture(t);
  // An earlier call's finished result: the call offers it (consent), then reads it after yes (result).
  db.prepare("INSERT INTO jobs(id,conversation,delegation,session,state,request,result,error,created,updated,title) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("job-earlier", conversation, "typed_x", "earlier-session", "completed", "user: PRIVATE_REQUEST_SENTINEL", "PRIVATE_RESULT_SENTINEL is the answer.", null, Date.now() - 60000, Date.now() - 60000, "a test task");
  const { page: p, errors } = await page(t, base, conversation, dir);
  await p.click("#startBtn");
  await p.waitForFunction(() => window.testPeer?.channel.readyState === "open");
  await event(p, { type: "session.started", session: { id: "x" } });
  // job-status: the job snapshot is sent at session start.
  await waitFor(() => sentWith(p, /Task status from the app/), "job-status send");
  // consent: the waiting-results line after a 2 s pause.
  await waitFor(() => sentWith(p, /finished while you were away/), "waiting line", 8000);
  // memory: a changed section is held until the user speaks; clock too.
  await p.evaluate(() => window.testSources.at(-1).onmessage({ data: JSON.stringify({ type: "memory.context",
    models: [{ id: "m1", revision: "r2", context: "Personal memory section m1. PRIVATE_MEMORY_SENTINEL" }] }) }));
  await say(p, "Yes, tell me.", 3000);
  await waitFor(() => sentWith(p, /PRIVATE_MEMORY_SENTINEL/), "memory send");
  await waitFor(() => sentWith(p, /Current browser-local date and time/), "clock send");
  // result: read after the yes settles and a fresh pause.
  const resultEvent = await waitFor(() => sentWith(p, /PRIVATE_RESULT_SENTINEL/), "result send", 10000);
  // GPT-Live acknowledges the result in its own session, which makes the delivery injected.
  await event(p, { type: "session.commentary.appended", client_event_id: resultEvent.event_id });
  // save-confirmation: a completed memory save.
  await p.evaluate(() => window.testSources.at(-1).onmessage({ data: JSON.stringify({ type: "memory.state", state: "saved", saved: "User said: PRIVATE_SAVED_SENTINEL" }) }));
  await waitFor(() => sentWith(p, /Memory save confirmed/), "save confirmation");
  // instructions: the user says stop.
  await say(p, "Stop.", 9000);
  await waitFor(() => sentWith(p, /The user just told you to stop/), "stop instructions");
  // cut-off: a new request and its answer reopen delivery, then the connection drops mid-answer.
  await new Promise((resolve) => setTimeout(resolve, 2000)); // a new turn, not more of "stop"
  await say(p, "What's the capital of France?", 12000);
  await event(p, { type: "session.output_transcript.delta", event_id: "a1", delta: "Paris is the capital and", start_ms: 13000, end_ms: 14000 });
  await p.evaluate(() => { window.testPeer.connectionState = "failed"; window.testPeer.onconnectionstatechange(); });
  await p.waitForFunction(() => window.testPeer.channel.readyState === "open" && window.testSent.length > 0, null, { timeout: 15000 });
  await waitFor(() => sentWith(p, /We got cut off/), "cut-off offer", 15000).catch(async (e) => {
    console.log(JSON.stringify((await p.evaluate(() => window.__voiceLabEvents.map((x) => [x.ts, x.type, x.reason || x.job || ""]))).slice(-40)));
    throw e;
  });
  // Acknowledge every append the way GPT-Live does, then reject one unknown id.
  const sent = await appends(p);
  for (const e of sent) if (e.event_id !== resultEvent.event_id) await event(p, { type: e.type.replace(/append$/, "appended"), client_event_id: e.event_id });
  await event(p, { type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "PRIVATE_ERROR_SENTINEL", event_id: "never_sent_0" } });

  const sends = await waitFor(() => rows(db, "model.send").length >= sent.length && rows(db, "model.send"), "send rows");
  const acks = await waitFor(() => rows(db, "model.ack").length >= sent.length && rows(db, "model.ack"), "ack rows");
  const rejected = await waitFor(() => rows(db, "model.rejected")[0], "rejection row");
  assert.equal(sends.length, sent.length, "exactly one send row per append sent on the channel");
  for (const e of sent) {
    const row = sends.find((r) => r.detail.eventId === e.event_id);
    assert.ok(row, `send row for ${e.event_id}`);
    assert.equal(row.conversation, conversation);
    assert.equal(row.detail.eventType, e.type);
    assert.equal(row.detail.contentLength, e.content.length);
    assert.equal(row.detail.delegationId, e.delegation_id);
    assert.ok(row.callId && row.session, "correlated to call and session");
    const ack = acks.find((r) => r.detail.eventId === e.event_id);
    assert.ok(ack, `ack row for ${e.event_id}`);
    assert.equal(ack.detail.purpose, row.detail.purpose);
    assert.equal(ack.callId, row.callId);
    assert.ok(ack.detail.ackAt >= row.detail.sentAt && ack.detail.ackMs >= 0);
  }
  const purposes = new Set(sends.map((r) => r.detail.purpose));
  for (const purpose of ["job-status", "consent", "memory", "clock", "result", "save-confirmation", "instructions", "cut-off"])
    assert.ok(purposes.has(purpose), `a ${purpose} send was recorded (${[...purposes]})`);
  assert.equal(sends.find((r) => r.detail.purpose === "result").detail.eventType, "session.commentary.append");
  assert.equal(sends.find((r) => r.detail.purpose === "instructions").detail.eventType, "session.instructions.append");
  assert.ok(new Set(sends.map((r) => r.session)).size >= 2, "the reconnected session's sends carry their own session");
  assert.equal(rejected.detail.eventId, "never_sent_0");
  assert.equal(rejected.detail.purpose, "unknown");
  // The result's delivery transitions and the app's own decisions are audit rows too, each tied to
  // the job, offer event, session and call.
  const offered = rows(db, "delivery.offered").find((r) => r.job === "job-earlier");
  assert.ok(offered?.event && offered.session, "delivery.offered row with its offer event");
  const injected = await waitFor(() => rows(db, "delivery.injected").find((r) => r.job === "job-earlier"), "delivery.injected row");
  assert.equal(injected.event, offered.event);
  const resultSend = sends.find((r) => r.detail.purpose === "result");
  assert.equal(resultSend.detail.eventId, `${offered.event}_0`, "the result send's event id is the delivery offer id");
  for (const kind of ["result.waiting_offered", "delivery.consent", "delivery.stop", "result.cut_off_offered"]) {
    const row = rows(db, kind)[0];
    assert.ok(row, `${kind} audit row`);
    assert.ok(row.callId && row.session && row.at, `${kind} carries call, session and time`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE payload LIKE '%PRIVATE_%'").get().n, 0, "content text is never logged");
  assert.deepEqual(errors, []);
});
