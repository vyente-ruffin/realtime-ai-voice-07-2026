import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceStore, liveHistory } from "../../src/live/store.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  const path = join(dir, "state.sqlite");
  const store = new VoiceStore(path);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}
function job(store, conversation, delegation = "d") {
  return store.enqueue(conversation, "s", delegation, "Find the result.");
}
test("lost submit acknowledgment cannot execute the same delegation twice", async (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  const a = job(store, c);
  const b = job(store, c);
  assert.equal(a.id, b.id);
  assert.equal(store.jobs(c).length, 1);
});
test("restart preserves queued jobs, flags uncertain work and does not rerun an action", async (t) => {
  const { store, path } = fixture(t);
  const c = store.createConversation().id;
  const a = job(store, c, "a"),
    b = job(store, c, "b");
  store.updateJob(a.id, "running");
  store.close();
  const reopened = new VoiceStore(path);
  t.after(() => reopened.close());
  reopened.recover();
  assert.equal(reopened.job(a.id).state, "interrupted");
  assert.equal(reopened.nextJob().id, b.id);
  assert.match(reopened.job(a.id).error, /not run again/);
});
test("a context acknowledgment is not treated as heard speech; reconnect cannot repeat a result blindly", (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  const a = job(store, c);
  store.updateJob(a.id, "completed", { result: "42" });
  const offer = store.offer(a, "live1");
  assert.ok(offer);
  assert.equal(store.offer(a, "live2"), null);
  assert.equal(store.deliveryAck(a.id, "wrong", offer.event), false);
  assert.equal(store.deliveryAck(a.id, "live1", offer.event), true);
  assert.equal(store.delivery(a.id).state, "injected");
  assert.equal(store.offer(a, "live2"), null);
});
test("known unsent delivery may safely be offered after reconnect", (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  const a = job(store, c);
  const x = store.offer(a, "live1");
  store.releaseOffer(a.id, "live1", x.event);
  assert.ok(store.offer(a, "live2"));
});
test("replayed transcript fragments are retained once and survive reconnect in the correct order", (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  const e = {
    type: "session.input_transcript.delta",
    event_id: "u1",
    delta: "My dog is ",
    start_ms: 0,
    end_ms: 300,
  };
  assert.equal(store.fragment(c, "s", e), true);
  assert.equal(store.fragment(c, "s", e), false);
  store.fragment(c, "s", {
    ...e,
    event_id: "u2",
    delta: "Pixel.",
    start_ms: 310,
    end_ms: 600,
  });
  assert.equal(
    liveHistory(store.history(c))[0].content[0].text,
    "My dog is Pixel.",
  );
  store.db.prepare("UPDATE fragments SET at=?").run(Date.now() - 4000);
  store.queueMemory();
  const saved = store.pendingMemory();
  assert.match(saved.content, /My dog is Pixel/);
  store.queueMemory();
  assert.equal(store.db.prepare("SELECT count(*) n FROM retention").get().n, 1);
});
test("assistant guesses are not promoted into user memory", (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  store.fragment(c, "s", {
    type: "session.output_transcript.delta",
    event_id: "a1",
    delta: "Your favorite color must be red.",
  });
  store.db.prepare("UPDATE fragments SET at=?").run(Date.now() - 4000);
  store.queueMemory();
  assert.equal(store.pendingMemory(), undefined);
});
// Worker behaviour against Hermes runs (concurrency, cancel, approvals, failures) is in hermes-runs.test.mjs.
test("a personal conversation and its jobs follow the user to another device", (t) => {
  const { store } = fixture(t);
  const desktop = store.defaultConversation();
  const task = job(store, desktop.id);
  const phone = store.defaultConversation();
  assert.equal(phone.id, desktop.id);
  assert.equal(store.jobs(phone.id)[0].id, task.id);
});

test("task status stays ordered when updates share a clock tick", (t) => {
  const { store } = fixture(t);
  t.mock.method(Date, "now", () => 1000);
  const c = store.createConversation().id;
  const queued = job(store, c);
  const running = store.updateJob(queued.id, "running");
  const completed = store.updateJob(queued.id, "completed", { result: "42" });
  assert.ok(running.updated > queued.updated);
  assert.ok(completed.updated > running.updated);
});

test("recent memory context preserves corrections and separate conversations in order", (t) => {
  const { store } = fixture(t);
  t.mock.method(Date, "now", () => 1000);
  const c = store.createConversation().id;
  const add = (session, role, id, delta, start) => store.fragment(c, session, {
    type: `session.${role}_transcript.delta`, event_id: id, delta,
    start_ms: start, end_ms: start + 200,
  });
  add("s1", "input", "1", "I prefer ", 0);
  add("s1", "input", "2", "jasmine tea.", 200);
  add("s1", "output", "3", "Noted.", 400);
  add("s1", "input", "4", "Actually, I prefer ", 800);
  add("s1", "input", "5", "green tea now.", 1000);
  add("s2", "input", "6", "What is my dog's name?", 0);
  const lines = store.recentUserStatements().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /I prefer jasmine tea\./);
  assert.match(lines[1], /Actually, I prefer green tea now\./);
  assert.match(lines[2], /What is my dog's name\?/);
  assert.doesNotMatch(lines.join("\n"), /Noted/);
});

test("memory is called saved only after every user update is durably processed", (t) => {
  const { store } = fixture(t);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const c = store.createConversation().id;
  const first = store.remember(c, "My preferred tea is jasmine.");
  const second = store.remember(c, "Actually, it is green tea.");
  store.memoryState(first, "completed");
  assert.equal(store.memorySaveStatus(c), "saving");
  store.memoryState(second, "completed");
  assert.equal(store.memorySaveStatus(c), "saved");
  store.fragment(c, "s", {type: "session.input_transcript.delta", event_id: "new", delta: "My dog is Pixel.", start_ms: 0, end_ms: 500});
  assert.equal(store.memorySaveStatus(c), "saving");
  now += 4000;
  store.queueMemory();
  store.memoryState(store.pendingMemory().id, "failed");
  assert.equal(store.memorySaveStatus(c), "failed");
});
