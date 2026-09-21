import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceStore, liveHistory } from "../../src/live/store.js";
import { VoiceWorker } from "../../src/live/worker.js";
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
test("twenty queued jobs produce twenty durable outcomes while submissions remain available", async (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  let count = 0,
    active = 0,
    max = 0;
  const updates = [];
  const client = {
    start: async () => {},
    isAlive: () => true,
    newSession: async () => {},
    prompt: async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return { stopReason: "end_turn", text: `Result ${++count}` };
    },
    stop() {},
  };
  const w = new VoiceWorker({
    store,
    onUpdate: (j) => updates.push(j),
    clientFactory: () => client,
  });
  for (let i = 0; i < 20; i++) job(store, c, `d${i}`);
  await w.kick();
  assert.equal(max, 1);
  assert.equal(store.jobs(c).filter((x) => x.state === "completed").length, 20);
  assert.equal(updates.filter((x) => x.state === "completed").length, 20);
});
test("a speech interruption has no worker cancel path; an explicit task cancellation cannot become completion", async (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  const a = job(store, c);
  let finish, started;
  const ready = new Promise((r) => (started = r));
  let cancelled = 0;
  const client = {
    start: async () => {},
    isAlive: () => true,
    newSession: async () => {},
    prompt: () => {
      started();
      return new Promise((r) => (finish = r));
    },
    cancel() {
      cancelled++;
    },
    stop() {},
  };
  const w = new VoiceWorker({
    store,
    onUpdate: () => {},
    clientFactory: () => client,
  });
  const running = w.kick();
  await ready;
  assert.equal(cancelled, 0);
  w.cancel(store.job(a.id));
  finish({ stopReason: "end_turn", text: "Late result" });
  await running;
  assert.equal(cancelled, 1);
  assert.equal(store.job(a.id).state, "cancelled");
});
test("permission choices must belong to the active job and preserve the request id", async (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  const a = job(store, c);
  const answers = [];
  const w = new VoiceWorker({ store, onUpdate: () => {} });
  w.current = a;
  w.client = { answerPermission: (...args) => answers.push(args) };
  w.permission({
    id: 7,
    toolCall: { title: "Write file" },
    options: [{ optionId: "yes", name: "Allow once" }],
  });
  assert.throws(() => w.answer("other", "7", "yes"));
  assert.throws(() => w.answer(a.id, "7", "invented"));
  w.answer(a.id, "7", "yes");
  assert.deepEqual(answers, [[7, "yes"]]);
});

test("Hermes transport failures returned as text never become completed jobs", async (t) => {
  const { store } = fixture(t);
  const c = store.createConversation().id;
  const a = job(store, c);
  const client = {
    start: async () => {},
    isAlive: () => true,
    newSession: async () => {},
    prompt: async () => ({
      stopReason: "end_turn",
      text: "Error: provider failed",
    }),
    stop() {},
  };
  const worker = new VoiceWorker({
    store,
    onUpdate: () => {},
    clientFactory: () => client,
  });
  await worker.kick();
  assert.equal(store.job(a.id).state, "failed");
  assert.equal(store.job(a.id).result, null);
});

test("a personal conversation and its jobs follow the user to another device", (t) => {
  const { store } = fixture(t);
  const desktop = store.defaultConversation();
  const task = job(store, desktop.id);
  const phone = store.defaultConversation();
  assert.equal(phone.id, desktop.id);
  assert.equal(store.jobs(phone.id)[0].id, task.id);
});
