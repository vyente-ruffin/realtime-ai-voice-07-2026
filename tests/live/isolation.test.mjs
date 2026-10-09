/** Fix 3 prerequisites: live test calls stay out of the owner's conversation and memory,
 * and each voice call gets its own Hermes session. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VoiceStore } from "../../src/live/store.js";
import { VoiceWorker } from "../../src/live/worker.js";
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
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-isolation-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}
const said = (store, conversation, session, text, at = Date.now()) =>
  store.fragment(conversation, session, { type: "session.input_transcript.delta", delta: text, event_id: `${text}-${at}`, start_ms: at, end_ms: at + 1 });

async function server(t) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-isolation-server-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const path = join(dir, "state.sqlite");
  const config = join(dir, "memory.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://127.0.0.1:1", bank_id: "synthetic" }));
  // VOICE_QUALIFICATION=0 as in production: test conversations must not need the qualification mode.
  const child = spawn(process.execPath, ["tests/live/server-fixture.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VOICE_STATE_PATH: path, VOICE_QUALIFICATION: "0",
      APPLICATIONINSIGHTS_CONNECTION_STRING: "", AZURE_OPENAI_ENDPOINT: "https://synthetic.invalid",
      AZURE_OPENAI_DEPLOYMENT_NAME: "test", HINDSIGHT_CONFIG_PATH: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
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
  for (let i = 0; i < 200 && !ready; i++) {
    try { ready = (await fetch(base + "/healthz")).ok; } catch {}
    if (!ready) await sleep(25);
  }
  assert.ok(ready, logs);
  const token = (await (await fetch(base + "/auth-refresh")).json()).token;
  const post = (route, body) => fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Auth": token }, body: JSON.stringify(body),
  });
  const key = () => {
    const d = new DatabaseSync(path, { readOnly: true });
    try {
      return JSON.parse(d.prepare("SELECT value FROM cache WHERE key='test-key'").get().value);
    } finally {
      d.close();
    }
  };
  return { post, key, path };
}

test("isolation: a test run gets its own conversation; the owner's conversation is never handed out to it", async (t) => {
  const { post, key, path } = await server(t);
  const owner = await (await post("/api/conversations", {})).json();
  const made = await post("/api/conversations", { test: { key: key(), run: "fix3-unit" } });
  assert.equal(made.status, 200);
  const testConversation = (await made.json()).id;
  assert.notEqual(testConversation, owner.id);
  // The page reconnects with its stored id and stays in the test conversation.
  assert.equal((await (await post("/api/conversations", { id: testConversation })).json()).id, testConversation);
  // The owner's page still gets the owner's conversation.
  assert.equal((await (await post("/api/conversations", { id: owner.id })).json()).id, owner.id);
  assert.equal((await (await post("/api/conversations", {})).json()).id, owner.id);
  // Without the local key nobody can mint test conversations.
  assert.equal((await post("/api/conversations", { test: { key: "wrong", run: "x" } })).status, 403);
  assert.equal((await post("/api/conversations", { test: { key: key(), run: "bad run name!" } })).status, 403);
  const d = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(d.prepare("SELECT test FROM conversations WHERE id=?").get(testConversation).test, "fix3-unit");
    assert.equal(d.prepare("SELECT test FROM conversations WHERE id=?").get(owner.id).test, null);
  } finally {
    d.close();
  }
});

test("isolation: test speech never reaches the owner's prompt history or voice memory saves", (t) => {
  const store = tempStore(t);
  const owner = store.defaultConversation().id;
  const probe = store.createConversation("fix3-unit").id;
  const now = Date.now() - 10000;
  said(store, owner, "owner-call", "owner statement", now);
  said(store, probe, "test-call", "test only utterance", now + 10);
  assert.match(store.recentUserStatements(), /owner statement/);
  assert.doesNotMatch(store.recentUserStatements(), /test only utterance/);
  assert.equal(store.history(owner).some((f) => /test only/.test(f.text)), false);
  store.db.exec("UPDATE fragments SET at=at-10000"); // past the 3 s quiet gap before a save
  store.queueMemory();
  const saved = store.db.prepare("SELECT conversation,content FROM retention").all();
  assert.deepEqual(saved.map((r) => r.conversation), [owner]);
  assert.doesNotMatch(saved.map((r) => r.content).join(), /test only utterance/);
  // Test fragments are settled so they are never retried as memory saves.
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fragments WHERE conversation=? AND retained=0").get(probe).n, 0);
});

test("session scope: each voice call has its own Hermes session; a later call never continues an earlier one", async (t) => {
  const store = tempStore(t);
  const hermes = fakeHermes();
  const worker = new VoiceWorker({ store, key: "k", baseUrl: "http://hermes.test", fetch: hermes.fetch, onUpdate: () => {}, retryMs: 10, idleMs: 2000 });
  const conversation = store.createConversation().id;
  const first = store.enqueue(conversation, "call-A", "d1", "user: one");
  const done1 = worker.kick();
  await until(() => store.job(first.id).run_id, "first run");
  hermes.complete("run_1", "One.");
  await done1;
  const second = store.enqueue(conversation, "call-B", "d2", "user: two");
  const done2 = worker.kick();
  await until(() => store.job(second.id).run_id, "second run");
  hermes.complete("run_2", "Two.");
  await done2;
  assert.equal(hermes.runs.get("run_1").session_id, `voice-${conversation}-call-A`);
  assert.equal(hermes.runs.get("run_2").session_id, `voice-${conversation}-call-B`);
  assert.equal(store.job(second.id).hermes_session, `voice-${conversation}-call-B`);
});

test("cleanup: the live harness always runs cleanup and the cleanup uses only the documented invalidate call", () => {
  const harness = readFileSync(join(root, "scripts/live-e2e/harness.mjs"), "utf8");
  const cleanup = readFileSync(join(root, "scripts/live-e2e/cleanup.mjs"), "utf8");
  assert.match(harness, /cleanup/);
  assert.match(cleanup, /method: "PATCH"/);
  assert.match(cleanup, /state: "invalidated"/);
  assert.doesNotMatch(cleanup, /method: "DELETE"/);
});
