import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceMemory } from "../../src/live/memory.js";
import { VoiceStore } from "../../src/live/store.js";
import { MemoryContext } from "../../web/memory-context.js";
import { maxMemoryCharacters } from "../../src/live/memory-models.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-memory-"));
  const configPath = join(dir, "hindsight.json");
  writeFileSync(configPath, JSON.stringify({ api_url: "http://memory.test", bank_id: "synthetic" }));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const published = [];
  const memory = new VoiceMemory({ configPath, modelIds: ["profile", "preferences", "current"], store,
    onRefresh: models => published.push(models) });
  let models = new Map([
    ["profile", { id: "profile", content: "The user's name is Morgan.", last_refreshed_at: "2026-09-22T00:00:00Z" }],
    ["preferences", { id: "preferences", content: "The user prefers jasmine tea." }],
    ["current", { id: "current", content: "The user is working on Lantern." }],
  ]);
  const reads = [];
  memory.request = async path => {
    reads.push(path);
    const model = models.get(path.split("/").at(-1));
    if (!model) throw new Error("Memory unavailable");
    return model;
  };
  return { memory, store, models, reads, published };
}

test("prepared facts are complete and available without a lookup on the response path", async t => {
  const { memory, reads } = fixture(t);
  await memory.refresh();
  assert.equal(reads.length, 3);
  const context = memory.context();
  assert.match(context, /Morgan/);
  assert.match(context, /jasmine/);
  assert.match(context, /Lantern/);
  assert.equal(reads.length, 3, "building session context must not query Hindsight");
  const before = memory.snapshot();
  await memory.refresh();
  assert.deepEqual(memory.snapshot(), before);
});

test("one failed section cannot erase the last good facts or hold up other updates", async t => {
  const { memory, models } = fixture(t);
  await memory.refresh();
  models.delete("profile");
  models.set("preferences", { id: "preferences", content: "The user now prefers mint tea." });
  await memory.refresh();
  assert.match(memory.context(), /Morgan/);
  assert.match(memory.context(), /mint/);
  assert.match(memory.lastError, /profile/);
  assert.equal(memory.prepared.length, 3);
});

test("oversized or mismatched sections are rejected, never silently cut into partial facts", async t => {
  const { memory, models } = fixture(t);
  await memory.refresh();
  models.set("profile", { id: "profile", content: "x".repeat(maxMemoryCharacters + 1) });
  models.set("current", { id: "another-user", content: "Wrong user's project." });
  await memory.refresh();
  assert.match(memory.context(), /Morgan/);
  assert.match(memory.context(), /Lantern/);
  assert.doesNotMatch(memory.context(), /Wrong user/);
  assert.match(memory.lastError, /profile, current/);
});

test("freshness timestamps alone do not inject the same facts again", async t => {
  const { memory, models } = fixture(t);
  await memory.refresh();
  const revision = memory.snapshot()[0].revision;
  models.get("profile").last_refreshed_at = "2026-09-22T01:00:00Z";
  await memory.refresh();
  assert.equal(memory.snapshot()[0].revision, revision);
});

test("a retained user correction reaches a refreshed section without saving assistant guesses", async t => {
  const { memory, store, models, published } = fixture(t);
  await memory.refresh();
  const conversation = store.createConversation().id;
  store.fragment(conversation, "live-test", { type: "session.input_transcript.delta", event_id: "user",
    delta: "My preferred name is Mo, not Morgan." });
  store.fragment(conversation, "live-test", { type: "session.output_transcript.delta", event_id: "assistant",
    delta: "I guess your hometown is London." });
  store.db.prepare("UPDATE fragments SET at=?").run(Date.now() - 4000);
  let retained;
  const request = memory.request;
  memory.request = async (path, body) => {
    if (path === "/memories") { retained = body; return {}; }
    if (path.startsWith("/operations/")) return { status: "completed" };
    return request(path, body);
  };
  await memory.drain();
  assert.equal(retained.async, true);
  assert.match(retained.items[0].content, /preferred name is Mo/);
  assert.doesNotMatch(retained.items[0].content, /London/);
  store.db.prepare("UPDATE retention SET next_at=0").run();
  await memory.drain();
  assert.equal(store.memorySaveStatus(conversation), "saved");
  // Simulate the external consolidation completion; the real service is tested separately.
  models.set("profile", { id: "profile", content: "The user's preferred name is Mo." });
  await memory.refresh();
  assert.match(published.at(-1)[0].context, /preferred name is Mo/);
  assert.match(memory.context(), /preferred name is Mo/);
});

test("quiet updates wait for every acknowledgment and serialize newer corrections", () => {
  const sent = [], accepted = [];
  const bridge = new MemoryContext((type, content) => {
    const ids = [`part-${sent.length}-1`, `part-${sent.length}-2`];
    sent.push({ type, content, ids }); return ids;
  }, model => accepted.push(model));
  bridge.reset([{ id: "profile", revision: "old" }]);
  bridge.receive([{ id: "profile", revision: "old", context: "Old facts" }]);
  assert.equal(sent.length, 0);
  bridge.receive([{ id: "profile", revision: "new", context: "Corrected facts" }]);
  bridge.receive([{ id: "profile", revision: "newer", context: "Latest correction" }]);
  assert.equal(sent.length, 1);
  bridge.acknowledge(sent[0].ids[1]);
  assert.equal(accepted.length, 0);
  bridge.acknowledge(sent[0].ids[0]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].content, "Latest correction");
  for (const id of sent[1].ids) bridge.acknowledge(id);
  bridge.receive([{ id: "profile", revision: "newer", context: "Latest correction" }]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(event => event.type === "session.thinking.append"));
  assert.equal(accepted.at(-1).revision, "newer");
});

test("disconnection preserves pending context and reconnect starts with its loaded revisions", () => {
  const sent = [];
  let connected = false;
  const bridge = new MemoryContext((type, content) => {
    if (!connected) return [];
    sent.push({ type, content }); return ["event-1"];
  });
  const model = { id: "profile", revision: "new", context: "New facts" };
  bridge.receive([model]);
  assert.equal(sent.length, 0);
  connected = true;
  bridge.flush();
  assert.equal(sent.length, 1);
  bridge.reset([model]);
  bridge.receive([model]);
  bridge.acknowledge("event-1");
  assert.equal(sent.length, 1);
});

test("provider rejection retries on a later snapshot without an immediate retry loop", () => {
  const sent = [];
  const bridge = new MemoryContext((type, content) => { sent.push(content); return ["event-" + sent.length]; });
  const model = { id: "profile", revision: "new", context: "New facts" };
  bridge.receive([model]);
  bridge.reject("event-1");
  assert.equal(sent.length, 1);
  bridge.receive([model]);
  assert.equal(sent.length, 2);
  bridge.acknowledge("event-2");
  bridge.receive([model]);
  assert.equal(sent.length, 2);
});
