/** Fix 2: voice jobs are runs on the main Hermes API server, side by side, with honest health. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttp } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VoiceStore } from "../../src/live/store.js";
import { VoiceWorker, reasons } from "../../src/live/worker.js";
import { fakeHermes } from "./fake-hermes.mjs";

const root = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await sleep(5);
  }
}
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix2-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  const hermes = fakeHermes(options);
  const updates = [];
  const worker = new VoiceWorker({
    store, key: "test-key", baseUrl: "http://hermes.test", fetch: hermes.fetch,
    onUpdate: (j) => updates.push(j), retryMs: 10, idleMs: 2000,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conversation = store.createConversation().id;
  const job = (d, request = `Request ${d}`) => store.enqueue(conversation, "call-1", d, request);
  return { store, hermes, worker, updates, conversation, job, dir };
}

test("2a: the worker has no Hermes child process or ACP client", () => {
  const source = readFileSync(join(root, "src/live/worker.js"), "utf8");
  assert.doesNotMatch(source, /acp-client|child_process|spawn\(|AcpClient/);
  assert.doesNotMatch(readFileSync(join(root, "src/live/server.js"), "utf8"), /acp-client|child_process|\.warm\(/);
});

test("2a: the running voice server process has no child processes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix2-ps-"));
  const config = join(dir, "memory.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://127.0.0.1:1", bank_id: "synthetic" }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/live/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VOICE_STATE_PATH: join(dir, "s.sqlite"),
      HINDSIGHT_CONFIG_PATH: config, HERMES_API_URL: "http://127.0.0.1:1", APPLICATIONINSIGHTS_CONNECTION_STRING: "",
      AZURE_OPENAI_ENDPOINT: "https://synthetic.invalid", AZURE_OPENAI_DEPLOYMENT_NAME: "test", AZURE_TOKEN: "synthetic" },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok, "server", 15000);
  await sleep(1000);
  let children = "";
  try {
    children = execFileSync("ps", ["--ppid", String(child.pid), "-o", "args="], { encoding: "utf8" });
  } catch (err) {
    children = err.stdout || ""; // ps exits 1 when nothing matches
  }
  assert.doesNotMatch(children, /hermes|acp/i);
});

test("2b: a job starts a Hermes run with the documented fields and stores its run id", async (t) => {
  const { store, hermes, worker, conversation, job } = setup(t);
  store.putCache(`session-context:${conversation}:call-1`, { timeZone: "Asia/Tokyo" });
  const a = job("a", "user: what is the weather?");
  const done = worker.kick();
  await until(() => hermes.runs.size === 1, "run started");
  const post = hermes.calls.find((c) => c.method === "POST" && c.path === "/v1/runs");
  assert.equal(post.headers.Authorization, "Bearer test-key");
  assert.equal(post.headers["Idempotency-Key"], a.id);
  assert.equal(post.headers["X-Hermes-Session-Key"], `voice:${conversation}`);
  assert.equal(post.body.input, "user: what is the weather?");
  assert.equal(post.body.session_id, `voice-${conversation}-call-1`);
  assert.match(post.body.instructions, /delegated from a live voice conversation/);
  assert.match(post.body.instructions, /Asia\/Tokyo/);
  await until(() => store.job(a.id).run_id === "run_1", "run id stored");
  assert.equal(store.job(a.id).state, "running");
  hermes.complete("run_1", "Sunny, 21 degrees.");
  await done;
  assert.equal(store.job(a.id).state, "completed");
  assert.equal(store.job(a.id).result, "Sunny, 21 degrees.");
});

test("2b: a retried start reuses the Idempotency-Key, so Hermes never runs the job twice", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  let failures = 1;
  const real = worker.fetch;
  worker.fetch = (url, init) => (init?.method === "POST" && failures-- > 0 ? Promise.reject(new TypeError("fetch failed")) : real(url, init));
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  hermes.complete(store.job(a.id).run_id, "ok");
  await done;
  assert.equal(hermes.runs.size, 1);
  assert.equal(store.job(a.id).state, "completed");
});

test("2c: memory defaults to the main profile's Hindsight config and the shipped drop-in uses it", () => {
  const server = readFileSync(join(root, "src/live/server.js"), "utf8");
  assert.match(server, /\.hermes\/hindsight\/config\.json/);
  assert.doesNotMatch(server, /profiles\/voice/);
  const dropIn = readFileSync(join(root, "deploy/live-production/voice-frontend-live.conf"), "utf8");
  assert.match(dropIn, /^Environment=HINDSIGHT_CONFIG_PATH=\/home\/localadmin\/\.hermes\/hindsight\/config\.json$/m);
  assert.doesNotMatch(dropIn, /voice-live-preview/);
});

test("2d: a broken event stream is followed by status polling, not a failed job", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  hermes.event("run_1", { event: "tool.started", tool: "terminal", preview: "ls" });
  hermes.runs.get("run_1").dropped = true; // connection reset mid-run
  for (const w of hermes.runs.get("run_1").waiters.splice(0)) w();
  await sleep(50);
  assert.equal(store.job(a.id).state, "running");
  hermes.complete("run_1", "Listed.");
  await done;
  assert.equal(store.job(a.id).state, "completed");
});

test("2e: a gateway restart settles the job as interrupted in plain words, with no result", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  hermes.state.down = true;
  hermes.restart();
  await sleep(60);
  assert.equal(store.job(a.id).state, "running", "unreachable Hermes is not a result");
  hermes.state.down = false;
  await done;
  const settled = store.job(a.id);
  assert.equal(settled.state, "interrupted");
  assert.equal(settled.error, reasons.interrupted);
  assert.equal(settled.result, null);
  assert.doesNotMatch(settled.error, /internal error|glitch|Gateway shutdown/i);
});

test("2e: a run Hermes no longer knows is interrupted, and a delivered interruption is never offered again", async (t) => {
  const { store, worker, job } = setup(t);
  const a = job("a");
  store.updateJob(a.id, "running");
  store.setRun(a.id, "run_gone", "voice-x");
  await worker.resume();
  assert.equal(store.job(a.id).state, "interrupted");
  const offer = store.offer(store.job(a.id), "call-1");
  assert.ok(store.deliveryAck(a.id, "call-1", offer.event));
  assert.equal(store.offer(store.job(a.id), "call-2"), null);
});

test("2e: a voice service restart reattaches to runs in flight instead of abandoning them", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const first = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  store.recover(); // what a restarted voice service does first
  assert.equal(store.job(a.id).state, "running");
  const again = new VoiceWorker({ store, key: "k", baseUrl: "http://hermes.test", fetch: hermes.fetch, onUpdate() {}, retryMs: 10 });
  const resumed = again.resume();
  hermes.complete("run_1", "Finished after restart.");
  await Promise.all([first, resumed]);
  assert.equal(store.job(a.id).state, "completed");
  assert.equal(hermes.runs.size, 1);
});

test("2f: jobs run side by side; a quick one finishes while a long one is still running", async (t) => {
  const { store, hermes, worker, job, conversation } = setup(t);
  const long = job("long");
  const longDone = worker.kick();
  await until(() => store.job(long.id).run_id, "long run");
  const quick = job("quick");
  const quickDone = worker.kick();
  await until(() => store.job(quick.id).run_id, "quick run");
  // One Hermes session runs one turn at a time, so the second job gets its own lane.
  assert.equal(hermes.runs.get("run_1").session_id, `voice-${conversation}-call-1`);
  assert.equal(hermes.runs.get("run_2").session_id, `voice-${conversation}-call-1-${quick.id.slice(0, 8)}`);
  hermes.complete("run_2", "Quick answer.");
  await quickDone;
  assert.equal(store.job(quick.id).state, "completed");
  assert.equal(store.job(long.id).state, "running");
  hermes.complete("run_1", "Long answer.");
  await longDone;
  // With the conversation idle again, the next job returns to the main session.
  const next = job("next");
  const nextDone = worker.kick();
  await until(() => store.job(next.id).run_id, "next run");
  assert.equal(hermes.runs.get("run_3").session_id, `voice-${conversation}-call-1`);
  hermes.complete("run_3", "ok");
  await nextDone;
});

test("2f: twenty jobs start without a local queue", async (t) => {
  const { store, hermes, worker, job, conversation } = setup(t, { cap: 50 });
  for (let i = 0; i < 20; i++) job(`d${i}`);
  const done = worker.kick();
  await until(() => hermes.runs.size === 20, "all runs started");
  assert.equal(hermes.active(), 20);
  for (const id of hermes.runs.keys()) hermes.complete(id, `Result ${id}`);
  await done;
  assert.equal(store.jobs(conversation).filter((x) => x.state === "completed").length, 20);
});

test("2f: HTTP 429 tells the user Hermes is at capacity instead of queueing quietly", async (t) => {
  const { store, hermes, worker, job } = setup(t, { cap: 1 });
  const a = job("a");
  const aDone = worker.kick();
  await until(() => store.job(a.id).run_id, "first run");
  const b = job("b");
  await worker.kick();
  assert.equal(store.job(b.id).state, "failed");
  assert.equal(store.job(b.id).error, reasons.capacity);
  assert.match(reasons.capacity, /I'm at capacity/);
  assert.equal(store.nextJob(), undefined, "nothing left queued");
  hermes.complete("run_1", "ok");
  await aDone;
});

test("cancel stops the Hermes run and a late completion cannot overwrite it", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  worker.cancel(store.job(a.id));
  await until(() => hermes.calls.some((c) => c.path === "/v1/runs/run_1/stop"), "stop sent");
  await done;
  hermes.runs.get("run_1").output = "Late result";
  assert.equal(store.job(a.id).state, "cancelled");
  assert.equal(store.job(a.id).result, null);
});

test("approvals come from Hermes approval.request and go back to /approval for the right job only", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  hermes.event("run_1", { event: "approval.request", request_id: "req-7", description: "Write file", choices: ["once", "deny"] });
  await until(() => store.job(a.id).state === "awaiting_permission", "awaiting");
  const [p] = [...worker.permissions.values()];
  assert.deepEqual(p.options.map((o) => o.optionId), ["once", "deny"]);
  await assert.rejects(worker.answer("other", p.id, "once"));
  await assert.rejects(worker.answer(a.id, p.id, "invented"));
  await worker.answer(a.id, p.id, "once");
  const call = hermes.calls.find((c) => c.path === "/v1/runs/run_1/approval");
  assert.deepEqual(call.body, { choice: "once", request_id: "req-7" });
  assert.equal(store.job(a.id).state, "running");
  hermes.complete("run_1", "Written.");
  await done;
});

test("a failed run is described in plain words, never raw Hermes error text", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  const run = hermes.runs.get("run_1");
  run.status = "failed";
  run.error = "Internal error: provider 500";
  hermes.event("run_1", { event: "run.failed", error: run.error });
  await done;
  assert.equal(store.job(a.id).state, "failed");
  assert.equal(store.job(a.id).error, reasons.failed);
  assert.equal(store.job(a.id).result, null);
});

/** Tiny stand-ins for Hermes and Hindsight /health so the real server process can be probed. */
async function healthServer(t, body) {
  const state = { body, up: true };
  const s = createHttp((req, res) => {
    if (!state.up) return req.socket.destroy();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state.body));
  });
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(() => s.close());
  return { url: `http://127.0.0.1:${s.address().port}`, state };
}

test("2g: /healthz is ready only when Hermes and Hindsight both answer, and names the one down", async (t) => {
  const hermes = await healthServer(t, { status: "ok" });
  const hindsight = await healthServer(t, { status: "healthy" });
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix2-health-"));
  const config = join(dir, "memory.json");
  writeFileSync(config, JSON.stringify({ api_url: hindsight.url, bank_id: "synthetic" }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/live/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VOICE_STATE_PATH: join(dir, "s.sqlite"),
      HINDSIGHT_CONFIG_PATH: config, HERMES_API_URL: hermes.url, APPLICATIONINSIGHTS_CONNECTION_STRING: "",
      AZURE_OPENAI_ENDPOINT: "https://synthetic.invalid", AZURE_OPENAI_DEPLOYMENT_NAME: "test", AZURE_TOKEN: "synthetic" },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  await until(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok, "server", 15000);
  let h = await health();
  assert.equal(h.status, "ready");
  assert.deepEqual(h.down, []);
  hermes.state.up = false;
  h = await health();
  assert.equal(h.status, "degraded");
  assert.deepEqual(h.down, ["hermes"]);
  hermes.state.up = true;
  hermes.state.body = { status: "starting" };
  assert.deepEqual((await health()).down, ["hermes"]);
  hermes.state.body = { status: "ok" };
  hindsight.state.up = false;
  h = await health();
  assert.equal(h.status, "degraded");
  assert.deepEqual(h.down, ["hindsight"]);
  hindsight.state.up = true;
  assert.equal((await health()).status, "ready");
});

test("send audit: each job state change leaves an audit row tying delegation, job and Hermes run id, without the request or result", async (t) => {
  const { store, hermes, worker, conversation, job } = setup(t);
  const a = job("item_trace", "user: PRIVATE_REQUEST_SENTINEL");
  const done = worker.kick();
  await until(() => hermes.runs.size === 1, "run started");
  hermes.complete("run_1", "PRIVATE_RESULT_SENTINEL");
  await done;
  const rows = store.db.prepare("SELECT kind,payload FROM audit WHERE conversation=? AND kind LIKE 'job.%' ORDER BY id").all(conversation)
    .map((r) => ({ kind: r.kind, ...JSON.parse(r.payload) }));
  assert.deepEqual(rows.map((r) => [r.kind, r.state]), [["job.state", "running"], ["job.run_started", "running"], ["job.state", "completed"]]);
  for (const r of rows) {
    assert.equal(r.job, a.id);
    assert.equal(r.delegation, "item_trace");
    assert.equal(r.session, "call-1");
  }
  assert.equal(rows[1].run, "run_1");
  assert.equal(rows[2].run, "run_1");
  assert.equal(rows[2].hermesSession, `voice-${conversation}-call-1`);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE payload LIKE '%PRIVATE_%'").get().n, 0);
});
