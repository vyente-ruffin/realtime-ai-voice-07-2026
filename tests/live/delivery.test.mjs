/** Fix 1 (docs/VOICE-FIX-PLAN.md): no unasked results, one per pause, silence after stop. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryPolicy, PAUSE_MS, OVERLAP_HOLD_MS, waitingLine } from "../../web/delivery-policy.js";
import { VoiceStore, deliveryCutoff } from "../../src/live/store.js";
import { instructions } from "../../src/live/policy.js";

const done = (id, session, extra = {}) => ({ id, session, state: "completed", delivery: "available", updated: 1, ...extra });
const user = (delta, start_ms = 0) => ({ type: "session.input_transcript.delta", delta, start_ms, end_ms: start_ms + 200 });
const said = (start_ms, end_ms) => ({ type: "session.output_transcript.delta", delta: "x", start_ms, end_ms });

function call(session = "now") {
  const p = new DeliveryPolicy();
  p.startCall();
  p.joinSession(session);
  return p;
}

test("1a: earlier-call results are never pushed; one waiting line is sent once", () => {
  const p = call();
  const jobs = [done("old1", "before"), done("old2", "before"), done("seen", "before", { delivery: "injected" }), done("half", "before", { delivery: "offered" })];
  let t = 10_000;
  const step = p.next(jobs, t, false);
  assert.equal(step.kind, "waiting");
  assert.deepEqual(step.jobs.map((j) => j.id), ["old1", "old2"], "offered/injected jobs do not count");
  assert.equal(step.text, "Two things finished while you were away. Want them?");
  p.sent(step, t);
  p.assistantSpeech(said(0, 2000), t + 100); // the line is spoken
  for (t += 3000; t < 80_000; t += 200) assert.equal(p.next(jobs, t, false), null, "silence: no result, no second line");
  assert.equal(waitingLine(1), "One thing finished while you were away. Want it?");
});

test("1b: an earlier result is spoken only after the user says yes", () => {
  const p = call();
  const jobs = [done("old1", "before")];
  p.sent(p.next(jobs, 10_000, false), 10_000);
  p.assistantSpeech(said(0, 2000), 10_100);
  assert.equal(p.userSpeech(user("Yes, tell me.", 70_000), 70_000), null, "judged on the whole turn");
  assert.equal(p.next(jobs, 70_000 + PAUSE_MS - 1, false), null, "waits for the pause");
  assert.equal(p.settled, "consent");
  assert.equal(p.next(jobs, 70_000 + PAUSE_MS, false).job.id, "old1");
});

test("1b: no, or anything else, leaves earlier results unread", () => {
  for (const answer of ["No, not now.", "What's the weather?", "Please tell me a long story about a lighthouse keeper.", "Tell me about Paris and its history please"]) {
    const p = call();
    const jobs = [done("old1", "before")];
    p.sent(p.next(jobs, 10_000, false), 10_000);
    p.userSpeech(user(answer, 20_000), 20_000);
    p.assistantSpeech(said(21_000, 22_000), 21_000);
    for (let t = 23_000; t < 60_000; t += 500) assert.equal(p.next(jobs, t, false), null);
  }
});

test("2: results from this call wait for a pause and go out one per pause", () => {
  const p = call();
  const jobs = [done("a", "now"), done("b", "now", { updated: 2 })];
  p.userSpeech(user("Do two things", 0), 1000);
  assert.equal(p.next(jobs, 2999, false), null, "user spoke under 2 s ago");
  assert.equal(p.next(jobs, 3000, true), null, "assistant is speaking");
  p.heard(3000); // microphone energy also blocks the pause
  assert.equal(p.next(jobs, 4999, false), null);
  const first = p.next(jobs, 5000, false);
  assert.equal(first.job.id, "a");
  p.sent(first, 5000);
  first.job.delivery = "offered";
  assert.equal(p.next(jobs, 30_000, false), null, "same pause: no second result");
  p.assistantSpeech(said(5000, 9000), 9000);
  assert.equal(p.next(jobs, 9000 + 600, false).job.id, "b", "next pause");
});

test("a reconnect inside the same call keeps its results as this call's", () => {
  const p = call("s1");
  p.joinSession("s2");
  assert.equal(p.next([done("a", "s1")], 10_000, false).kind, "result");
});

test("1c/1d: after stop nothing is pushed until a new request has been answered", () => {
  const p = call();
  const jobs = [done("a", "now"), done("b", "now", { updated: 2 })];
  const first = p.next(jobs, 10_000, false);
  p.sent(first, 10_000);
  first.job.delivery = "injected";
  p.assistantSpeech(said(10_000, 10_800), 10_800); // reading the first result
  assert.equal(p.userSpeech(user("Stop", 11_000), 11_000), "stop");
  p.userSpeech(user(".", 11_200), 11_200); // a trailing delta of the same turn
  p.assistantSpeech(said(11_100, 11_300), 11_300); // the cut-off tail of the result
  for (let t = 11_300; t < 41_300; t += 200) assert.equal(p.next(jobs, t, false), null, "30 s of silence after stop");
  p.userSpeech(user("What's the capital of France?", 45_000), 45_000);
  assert.equal(p.next(jobs, 50_000, false), null, "asked but not yet answered");
  p.assistantSpeech(said(46_000, 47_000), 50_000);
  assert.equal(p.next(jobs, 50_100, false), null, "the answer must finish first");
  assert.equal(p.next(jobs, 50_600, false).job.id, "b", "resumes after the answer");
});

test("1b live regression: a reply whose timestamps overlap the end of 'yes, tell me' is not an interruption", () => {
  const p = call();
  const jobs = [done("old1", "before")];
  p.sent(p.next(jobs, 10_000, false), 10_000);
  p.assistantSpeech(said(200, 1800), 11_000); // "One thing finished while you were away. Want it?"
  // Observed order and timestamps from session live_EX9miCFvadLE4jVcFGiPR:
  assert.equal(p.userSpeech(user(" Yes", 62_600), 70_000), null);
  assert.equal(p.userSpeech(user(", tell", 62_800), 70_001), null);
  p.assistantSpeech(said(62_800, 63_000), 70_002);
  assert.equal(p.userSpeech(user(" me.", 63_000), 70_700), null);
  p.assistantSpeech(said(63_000, 63_200), 70_701);
  assert.equal(p.locked, false, "a reply is not the user talking over the assistant");
  p.next(jobs, 72_000, false);
  assert.equal(p.settled, "consent");
  assert.equal(p.next(jobs, 73_000, false), null, "coarse overlap still holds delivery");
  assert.equal(p.next(jobs, 70_701 + OVERLAP_HOLD_MS, false).job.id, "old1");
});

test("1f live regression: no delivery within the hold after overlap, whichever transcript arrives first", () => {
  // Observed in session live_EX9owT2jVl3j6vNiTfn46: the user's ' twelve' [12600,12800]
  // arrived before the assistant's overlapping 'The' [12400,12600..], and a result went out 7.8 s later.
  for (const userFirst of [true, false]) {
    const p = call();
    const jobs = [done("a", "now")];
    const t = 100_000;
    if (userFirst) {
      p.userSpeech(user(" twelve", 12_600), t);
      p.assistantSpeech(said(12_400, 12_700), t + 1);
    } else {
      p.assistantSpeech(said(12_400, 12_700), t);
      p.userSpeech(user(" twelve", 12_600), t + 1);
    }
    p.assistantSpeech(said(12_700, 19_000), t + 2);
    p.lockStage === "answer" && p.assistantSpeech(said(19_000, 19_200), t + 3);
    p.locked = false; // isolate the hold from the talk-over lock
    assert.equal(p.next(jobs, t + 10_000, false), null, `held at 10 s (${userFirst ? "user" : "assistant"} first)`);
    assert.equal(p.next(jobs, t + 2 + OVERLAP_HOLD_MS, false)?.job.id, "a");
  }
});

test("1b live regression: a stray fragment during the waiting line neither answers it nor cancels it", () => {
  // Observed in session live_EXAGvL6ak66zTBOZe2R6j: user '-open|>' [600,800] inside the
  // assistant line [200,1600]; the lock it caused dropped the question and 'Yes. Tell me' was lost.
  for (const lineFirst of [true, false]) {
    const p = call();
    const jobs = [done("old1", "before")];
    p.sent(p.next(jobs, 10_000, false), 10_000);
    p.assistantSpeech(said(200, 600), 10_100);
    if (lineFirst) p.assistantSpeech(said(600, 1600), 10_101);
    p.userSpeech(user("-open|>", 600), 10_102);
    if (!lineFirst) p.assistantSpeech(said(600, 1600), 10_103);
    for (let t = 11_000; t < 70_000; t += 500) assert.equal(p.next(jobs, t, false), null, "no result before yes");
    assert.equal(p.awaitingConsent, true, "the question is still open");
    p.userSpeech(user("Yes.", 62_400), 70_000);
    p.userSpeech(user(" Tell me", 62_600), 70_200);
    p.next(jobs, 71_500, false);
    assert.equal(p.settled, "consent");
    p.assistantSpeech(said(63_400, 63_600), 71_600); // "Okay."
    assert.equal(p.next(jobs, 90_000, false)?.job.id, "old1");
  }
});

test("1c: quiet and shut up also lock delivery", () => {
  for (const word of ["Quiet, please.", "Shut up"]) {
    const p = call();
    p.userSpeech(user(word, 0), 0);
    assert.equal(p.next([done("a", "now")], 60_000, false), null);
  }
});

test("1f: talking over the assistant locks delivery; a reply after it does not", () => {
  const p = call();
  p.assistantSpeech(said(5000, 5200), 5000);
  p.assistantSpeech(said(5200, 5400), 5100);
  assert.equal(p.userSpeech(user("wait", 5300), 6000), "interrupt", "began during assistant speech");
  assert.equal(p.next([done("a", "now")], 60_000, false), null);
  const q = call();
  q.assistantSpeech(said(5000, 5400), 5000);
  assert.equal(q.userSpeech(user("thanks", 6000), 7000), null, "speech after the assistant ended is a reply");
  q.assistantSpeech(said(7000, 7400), 8000); // its answer starts after the user's speech
  assert.equal(q.userSpeech(user(" a lot", 6400), 8100), null, "a late delta of the same turn");
  assert.equal(q.next([done("a", "now")], 12_000, false).kind, "result");
});

test("1e: the backlog before the ship day is closed and can never be offered", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = store.createConversation().id;
  const mk = (d, state, updated) => {
    const j = store.enqueue(c, "s", d, "x");
    store.db.prepare("UPDATE jobs SET state=?,updated=? WHERE id=?").run(state, updated, j.id);
    return store.job(j.id);
  };
  const old = mk("a", "completed", deliveryCutoff - 1);
  const released = mk("b", "failed", deliveryCutoff - 5);
  const x = store.offer(released, "live1");
  store.releaseOffer(released.id, "live1", x.event); // back to available
  const heard = mk("c", "completed", deliveryCutoff - 9);
  const ack = store.offer(heard, "live1");
  store.deliveryAck(heard.id, "live1", ack.event);
  const running = mk("d", "running", deliveryCutoff - 1);
  const fresh = mk("e", "completed", deliveryCutoff + 1);
  assert.equal(store.closeBacklog(), 2);
  assert.equal(store.closeBacklog(), 0, "idempotent");
  assert.equal(store.delivery(old.id).state, "offered");
  assert.equal(store.delivery(released.id).state, "offered");
  assert.equal(store.delivery(heard.id).state, "injected", "already heard stays injected");
  assert.equal(store.delivery(running.id), undefined, "unfinished work is not closed");
  assert.equal(store.delivery(fresh.id), undefined, "after the ship day: normal rules");
  assert.equal(store.offer(old, "live2"), null);
  assert.equal(
    store.db.prepare(`SELECT COUNT(*) n FROM jobs j LEFT JOIN deliveries d ON d.job=j.id
      WHERE j.state IN ('completed','failed','cancelled','interrupted') AND j.updated<? AND (d.state IS NULL OR d.state='available')`).get(deliveryCutoff).n,
    0,
  );
});

test("speech instructions carry no result text and no rule to announce results", () => {
  const prompt = instructions("", [{ id: "j1", state: "completed", result: "The Oct 5 secret result", error: null }]);
  assert.doesNotMatch(prompt, /Oct 5 secret result/);
  assert.doesNotMatch(prompt, /Announce a supplied final outcome/);
  assert.match(prompt, /Never volunteer a task result/);
  assert.match(prompt, /stay silent/);
  assert.match(prompt, /At the start of a call, stay silent until the user speaks/);
  assert.match(prompt, /never continue it or repeat anything from it unasked/);
});

test("the page loads the delivery policy and no longer delivers any available job", () => {
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../src/live/server.js", import.meta.url), "utf8");
  assert.match(live, /import \{ DeliveryPolicy \} from "\.\/delivery-policy\.js"/);
  assert.match(server, /"\/web\/delivery-policy\.js"/);
  assert.match(server, /store\.closeBacklog\(deliveryCutoff\)/);
  assert.doesNotMatch(live, /deliveryInFlight/);
});
