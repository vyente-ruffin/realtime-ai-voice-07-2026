/** Exercise the real HTTP auth, validation and SQLite path, without upstream calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VoiceStore } from "../../src/live/store.js";
import { VoiceWorker } from "../../src/live/worker.js";
import { chromium } from "playwright";

/** Start a private fixture process and wait for its actual HTTP readiness. */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-observability-"));
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
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
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
  assert.ok(ready, logs);
  const token = (await (await fetch(base + "/auth-refresh")).json()).token;
  const post = (route, body, headers = {}) => fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Auth": token, ...headers },
    body: JSON.stringify(body),
  });
  const conversation = (await (await post("/api/conversations", { isolated: true })).json()).id;
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  return { post, conversation, db, base, token, path };
}

/** Minimal privacy-safe event; event IDs make retries distinguishable. */
function event(conversation, overrides = {}) {
  return { id: "event-1", conversation, session: "live-1", callId: "call-1",
    ts: Date.now(), type: "connection.channel.closed",
    detail: { reason: "remote_channel_closed", requested: false }, ...overrides };
}

test("telemetry saves correlated close evidence, even after a newer live session", async t => {
  const { post, conversation, db } = await fixture(t);
  await post("/api/live", { conversation, sdp: "v=0", synthetic: true });
  const item = event(conversation);
  const response = await post("/api/telemetry", { conversation, events: [item] });
  assert.equal(response.status, 200);
  const row = db.prepare("SELECT * FROM audit WHERE kind=?").get(item.type);
  assert.equal(row.conversation, conversation);
  const { type, ...payload } = item;
  assert.deepEqual(JSON.parse(row.payload), payload);
});

test("telemetry rejects malformed and private fields atomically with RFC 9457", async t => {
  const { post, conversation, db } = await fixture(t);
  const good = event(conversation);
  const badEvents = [null, {}, { ...good, conversation: "another" },
    { ...good, session: "x".repeat(201) }, { ...good, callId: "" },
    { ...good, id: "x".repeat(201) }, { ...good, ts: -1 },
    { ...good, type: "session.input_transcript.delta" },
    { ...good, detail: { message: "private speech" } },
    { ...good, detail: { reason: "x".repeat(1000) } },
    { ...good, detail: { bytesReceived: -1 } },
    { ...good, detail: { requested: "false" } },
    { ...good, secret: "do not log this" }];
  for (const events of [null, [], Array(51).fill(good), ...badEvents.map(bad => [good, bad])]) {
    const response = await post("/api/telemetry", { conversation, events });
    assert.equal(response.status, 400, JSON.stringify(events));
    assert.match(response.headers.get("content-type"), /application\/problem\+json/);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit").get().n, 0);
  for (const headers of [{ "X-Voice-Auth": "wrong" }, { Origin: "https://evil.invalid" }]) {
    assert.equal((await post("/api/telemetry", { conversation, events: [good] }, headers)).status, 403);
  }
  assert.equal((await post("/api/telemetry", { conversation, events: [good], padding: "x".repeat(131073) })).status, 413);
  for (const invalid of [null, [], {}, { conversation: {} }])
    assert.equal((await post("/api/telemetry", invalid)).status, 400);
});

test("live route validates timezone and worker uses the original session zone after reconnect", async t => {
  const { post, conversation, path } = await fixture(t);
  const first = await (await post("/api/live", { conversation, sdp: "v=0", timeZone: "Asia/Tokyo", callId: "call-tokyo" })).json();
  assert.match(first.session.testInstructions, /Asia\/Tokyo/);
  for (const timeZone of [undefined, "Invalid/Zone", { bad: true }]) {
    const next = await (await post("/api/live", { conversation, sdp: "v=0", timeZone })).json();
    assert.match(next.session.testInstructions, /America\/Los_Angeles/);
  }
  const store = new VoiceStore(path);
  t.after(() => store.close());
  const task = store.enqueue(conversation, first.session.id, "test-zone", "What time is it?");
  let prompt;
  const worker = new VoiceWorker({ store, onUpdate() {}, clientFactory: () => ({
    start: async () => {}, newSession: async () => {}, isAlive: () => true,
    prompt: async value => { prompt = value; return { stopReason: "end_turn", text: "Synthetic result" }; },
    stop() {},
  }) });
  await worker.kick();
  assert.equal(store.job(task.id).state, "completed");
  assert.match(prompt, /Asia\/Tokyo/);
  assert.doesNotMatch(prompt, /America\/Los_Angeles/);
});

test("real browser saves silent-close evidence, current zone, periodic quality and unload beacon", async t => {
  const { base, db } = await fixture(t);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ timezoneId: "Asia/Tokyo", permissions: ["microphone"] });
  await context.addInitScript(() => {
    // Only the provider WebRTC boundary is simulated; browser app/HTTP/SQLite are real.
    window.testPackets = 0;
    window.RTCPeerConnection = class extends EventTarget {
      constructor() { super(); window.testPeer = this; this.connectionState = "new"; this.iceConnectionState = "new"; this.iceGatheringState = "complete"; }
      addTrack() {}
      createDataChannel() { this.channel = { readyState: "connecting", send() {}, close() { this.readyState = "closed"; } }; return this.channel; }
      async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() {
        this.connectionState = "connected"; this.iceConnectionState = "connected";
        this.channel.readyState = "open";
        this.channel.onopen?.(); this.onconnectionstatechange?.();
      }
      async getStats() { return new Map([
        ["audio", { type: "inbound-rtp", kind: "audio", packetsReceived: window.testPackets, bytesReceived: window.testPackets * 100, jitter: 0.01 }],
        ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { type: "candidate-pair", currentRoundTripTime: 0.02 }],
      ]); }
      close() { this.connectionState = "closed"; }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/?synthetic=1");
  await page.click("#startBtn");
  await page.waitForFunction(() => window.testPeer?.channel.readyState === "open");
  const first = JSON.parse(db.prepare("SELECT payload FROM audit WHERE kind='session.started' ORDER BY id DESC LIMIT 1").get().payload);
  assert.equal(first.timeZone, "Asia/Tokyo");
  await page.evaluate(() => { const c = window.testPeer.channel; c.readyState = "closed"; c.onclose(); });
  await page.waitForResponse(r => r.url().includes("/api/telemetry") && r.ok(), { timeout: 5000 });
  let ended;
  for (let i = 0; i < 50; i++) {
    const row = db.prepare("SELECT payload FROM audit WHERE kind='call.ended' ORDER BY id DESC LIMIT 1").get();
    if (row) { ended = JSON.parse(row.payload); break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ended, "silent call needs durable end evidence");
  assert.equal(ended.session, first.session);
  assert.equal(ended.callId, first.callId);
  assert.equal(ended.detail.audioReceived, false);
  assert.equal(ended.detail.reason, "remote_channel_closed");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fragments").get().n, 0);
  await page.waitForFunction(() => window.testPeer?.channel.readyState === "open");
  await page.evaluate(() => { window.testPackets = 17; });
  // Real interval: exercise the live app rather than manually invoking a telemetry helper.
  await page.waitForResponse(r => r.url().includes("/api/telemetry") && r.request().postData()?.includes('"call.stats"'), { timeout: 8000 });
  const stats = JSON.parse(db.prepare("SELECT payload FROM audit WHERE kind='call.stats' ORDER BY id DESC LIMIT 1").get().payload);
  assert.equal(stats.detail.packetsReceived, 17);
  assert.equal(stats.detail.jitterSeconds, 0.01);
  assert.equal(stats.detail.roundTripTimeSeconds, 0.02);
  const errorSaved = page.waitForResponse(r => r.url().includes("/api/telemetry") && r.request().postData()?.includes('"connection.error"') && r.ok());
  await page.evaluate(() => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: "error", error: { message: "PRIVATE_ERROR_SENTINEL" } }) }));
  await errorSaved;
  const error = JSON.parse(db.prepare("SELECT payload FROM audit WHERE kind='connection.error' ORDER BY id DESC LIMIT 1").get().payload);
  assert.equal(error.session, stats.session);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE payload LIKE '%PRIVATE_ERROR_SENTINEL%'").get().n, 0);
  await page.click("#stopBtn");
  const stopped = page.waitForResponse(r => r.url().includes("/api/telemetry") && r.request().postData()?.includes('"call.ended"') && r.ok());
  await page.evaluate(() => window.testPeer.channel.onmessage({ data: JSON.stringify({ type: "session.closed" }) }));
  await stopped;
  const requested = JSON.parse(db.prepare("SELECT payload FROM audit WHERE kind='call.ended' ORDER BY id DESC LIMIT 1").get().payload);
  assert.equal(requested.detail.reason, "user_end");
  assert.equal(requested.detail.requested, true);
  await page.click("#startBtn");
  await page.waitForFunction(() => window.testPeer?.channel.readyState === "open");
  await page.waitForResponse(r => r.url().includes("/api/telemetry") && r.request().postData()?.includes('"call.stats"'), { timeout: 8000 });
  await page.goto("about:blank");
  let exit;
  for (let i = 0; i < 100; i++) {
    exit = db.prepare("SELECT payload FROM audit WHERE kind='connection.page.exit' ORDER BY id DESC LIMIT 1").get();
    if (exit) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(exit, "native sendBeacon must reach the local server during navigation");
  assert.equal(JSON.parse(exit.payload).detail.audioReceived, true);
  assert.deepEqual(errors, []);
});

test("native Chromium loopback audio produces real inbound counters and quality stats", async t => {
  const { base } = await fixture(t);
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  const summary = await page.evaluate(async () => {
    const { summarizeAudio } = await import("/web/telemetry.js");
    const sender = new RTCPeerConnection(), receiver = new RTCPeerConnection();
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const output = audio.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    await audio.resume();
    sender.addTrack(output.stream.getAudioTracks()[0], output.stream);
    /** Keep all ICE candidates in the local descriptions; no external STUN service. */
    async function local(peer, description) {
      await peer.setLocalDescription(description);
      const deadline = Date.now() + 10000;
      while (peer.iceGatheringState !== "complete" && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      if (peer.iceGatheringState !== "complete") throw new Error("Loopback ICE timeout");
    }
    try {
      await local(sender, await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription);
      await local(receiver, await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription);
      const deadline = Date.now() + 8000;
      let summary;
      do {
        await new Promise(resolve => setTimeout(resolve, 100));
        summary = summarizeAudio(await receiver.getStats());
      } while ((summary.bytesReceived === 0 || summary.roundTripTimeSeconds === null) && Date.now() < deadline);
      return summary;
    } finally {
      sender.close(); receiver.close(); oscillator.stop(); await audio.close();
    }
  });
  assert.ok(summary.packetsReceived > 0);
  assert.ok(summary.bytesReceived > 0);
  assert.equal(typeof summary.jitterSeconds, "number");
  assert.equal(typeof summary.roundTripTimeSeconds, "number");
});
