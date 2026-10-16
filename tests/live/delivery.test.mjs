/** Fix 1 (docs/VOICE-FIX-PLAN.md): no unasked results, one per pause, silence after stop. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryPolicy, PAUSE_MS, OVERLAP_HOLD_MS, waitingLine } from "../../web/delivery-policy.js";
import { VoiceStore, deliveryCutoff } from "../../src/live/store.js";
import { instructions } from "../../src/live/policy.js";
import { statusContext } from "../../web/status-context.js";

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
  // A clear short yes counts at once and the accepted result goes at once, even while the voice
  // says "Okay" (any wait left the voice room to make up its own version, seen live).
  assert.equal(p.next(jobs, 70_050, true).job.id, "old1");
  assert.equal(p.settled, "consent");
  // A longer reply that only starts with yes is judged on the whole turn, after it settles.
  const q = call();
  q.sent(q.next(jobs, 10_000, false), 10_000);
  q.assistantSpeech(said(0, 2000), 10_100);
  q.userSpeech(user("Yes, but first tell me what time it is in Tokyo.", 70_000), 70_000);
  assert.equal(q.next(jobs, 70_050, false), null);
  assert.equal(q.settled, null, "not a clear yes: waits for the whole turn");
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

test("double read: the voice handing the waiting-line 'yes, tell me' to the backend is answered by the app, not run again", () => {
  const p = call();
  const jobs = [done("old1", "before")];
  assert.equal(p.waitingReply(1000), false, "before the waiting line, a handoff is real work");
  const step = p.next(jobs, 10_000, false);
  p.sent(step, 10_000);
  p.assistantSpeech({ ...said(0, 2000), delta: "One thing finished while you were away. Want it?" }, 10_100);
  p.userSpeech(user("Yes, tell me.", 61_000), 70_000);
  assert.equal(p.waitingReply(70_100), true, "a handoff made by the yes, before it settles (seen live 0.6 s after the yes)");
  p.next(jobs, 71_300, false);
  assert.equal(p.settled, "consent");
  p.assistantSpeech({ ...said(62_000, 62_400), delta: "Okay." }, 71_400);
  assert.equal(p.waitingReply(72_000), true, "and just after, even once the voice has said okay");
  assert.equal(p.waitingReply(82_000), false, "later handoffs are real work");
  // A new user turn after the yes is a new request, handed off as usual.
  const q = call();
  q.sent(q.next(jobs, 10_000, false), 10_000);
  q.userSpeech(user("Yes, tell me.", 61_000), 70_000);
  q.next(jobs, 71_300, false);
  q.assistantSpeech({ ...said(62_000, 62_400), delta: "Okay." }, 71_400);
  q.userSpeech(user("And check the weather in Paris.", 64_000), 73_000);
  assert.equal(q.waitingReply(73_100), false, "a request after the yes is new work");
  // A different reply to the waiting line is not a yes.
  const r = call();
  r.sent(r.next(jobs, 10_000, false), 10_000);
  r.userSpeech(user("No, what time is it in Tokyo?", 61_000), 70_000);
  assert.equal(r.waitingReply(70_100), false, "a request instead of yes is handed off as usual");
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  assert.match(live, /if \(untranscribed \|\| delivery\.waitingReply\(Date\.now\(\)\)\) \{/);
});

test("double read: after a clear yes the first accepted result goes at once, not after a further pause; a stop or overlap still holds it", () => {
  const jobs = [done("old1", "before"), done("old2", "before")];
  const p = call();
  p.sent(p.next(jobs, 10_000, false), 10_000);
  p.assistantSpeech(said(0, 2000), 10_100);
  p.userSpeech(user("Yes, tell me.", 61_000), 70_000);
  const step = p.next(jobs, 70_100, true);
  assert.equal(p.settled, "consent");
  assert.equal(step?.kind, "result", "at once after a clear yes, even while the voice says okay");
  assert.equal(step.job.id, "old1");
  p.sent(step, 71_300);
  jobs[0].delivery = "offered";
  p.assistantSpeech(said(63_000, 66_000), 72_000);
  assert.equal(p.next(jobs, 72_300, false), null, "the second one still waits for its own pause");
  assert.equal(p.next(jobs, 75_000, false)?.job.id, "old2");
  // A voice that talks over the yes holds delivery (Fix 1 1f), and a stop locks it.
  const q = call();
  q.sent(q.next(jobs.map((j) => ({ ...j, delivery: "available" })), 10_000, false), 10_000);
  q.assistantSpeech(said(0, 2000), 10_100);
  q.assistantSpeech(said(61_100, 62_000), 70_000);
  q.userSpeech(user("Yes, tell me.", 61_000), 70_100);
  assert.equal(q.next(jobs.map((j) => ({ ...j, delivery: "available" })), 71_400, false), null, "overlap hold still applies");
  const r = call();
  r.sent(r.next(jobs.map((j) => ({ ...j, delivery: "available" })), 10_000, false), 10_000);
  r.userSpeech(user("Yes, tell me.", 61_000), 70_000);
  r.next([], 71_300, false);
  r.userSpeech(user("Stop.", 64_000), 72_000);
  assert.equal(r.next(jobs.map((j) => ({ ...j, delivery: "available" })), 75_000, false), null, "stop still locks");
});

test("conversation: a typed request reaches the voice only as its task name in the quiet status", () => {
  // A quiet context quoting the typed request was followed within 1 s by garbled speech, then
  // Korean or a made-up question (Oct 16); "The user typed: ..." earlier made the voice do it itself.
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  const typed = live.slice(live.indexOf("async function typed()"), live.indexOf("$(\"startBtn\").onclick"));
  assert.doesNotMatch(typed, /append\(/, "no append of its own");
  assert.match(typed, /updateJob\(result\.job\);/, "the status update names the task");
  assert.doesNotMatch(live, /The typed request:|`The user typed: \$\{text\}/);
  const status = statusContext([{ id: "j", state: "running", request: "user: How much disk is free?", created: 0, updated: 0 }], 1000);
  assert.match(status, /"How much disk is free\?": running/);
  assert.match(status, /silent update, not a request to speak/);
});

test("double read: the rule for the reply to the waiting line is in the session instructions, not a mid-call instruction", () => {
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  const block = live.slice(live.indexOf('if (step.kind === "waiting") {'), live.indexOf('record("result.waiting.offered"'));
  assert.doesNotMatch(block, /session\.instructions\.append/, "an instructions.append at the line made the voice talk (seen live)");
  assert.match(block, /Say exactly this one short sentence aloud, word for word, and nothing else: "\$\{step\.text\}" Then stop and wait for the user\./);
  assert.doesNotMatch(block, /`[^`]*result[^`]*`/, "the line's instruction does not talk about results");
  const prompt = instructions("", []);
  assert.match(prompt, /If the user says yes to it, answer only "Okay\." and nothing else, and never hand that yes to the backend/);
  assert.match(prompt, /Never state, guess or make up a task result yourself, even one the earlier conversation suggests\./);
});

test("double read: a waiting line not answered before a drop is asked again in the new session, once", () => {
  const jobs = [done("old1", "before")];
  const p = call("s1");
  const first = p.next(jobs, 10_000, false);
  assert.equal(first.kind, "waiting");
  p.sent(first, 10_000);
  p.joinSession("s2"); // dropped before the user answered
  const again = p.next(jobs, 20_000, false);
  assert.equal(again?.kind, "waiting", "the new session asks again");
  p.sent(again, 20_000);
  assert.equal(p.next(jobs, 40_000, false), null, "once per session");
  p.userSpeech(user("Yes, tell me.", 30_000), 50_000);
  assert.equal(p.next(jobs, 51_300, false)?.job.id, "old1", "the yes in the new session reads it");
  // An answered line is not asked again after a drop.
  const q = call("s1");
  q.sent(q.next(jobs, 10_000, false), 10_000);
  q.userSpeech(user("No, not now.", 5000), 12_000);
  q.next(jobs, 14_000, false);
  assert.equal(q.settled, "declined");
  q.joinSession("s2");
  for (let t = 20_000; t < 60_000; t += 1000) assert.equal(q.next(jobs, t, false), null);
});

test("double read: a handoff of a reply the transcript missed is the yes, answered by the app, not run again", () => {
  const jobs = [done("old1", "before")];
  const p = call();
  p.sent(p.next(jobs, 10_000, false), 10_000);
  p.assistantSpeech({ ...said(0, 2000), delta: "One thing finished while you were away. Want it?" }, 10_100);
  p.heard(15_000); // the microphone heard the user, but no transcript arrived
  assert.equal(p.waitingReply(15_500), false);
  assert.equal(p.acceptUntranscribedReply(15_500), true, "the handoff is the reply");
  assert.equal(p.waitingReply(15_600), true, "a second handoff of the same reply is answered too");
  assert.equal(p.next(jobs, 15_700, true)?.job.id, "old1", "the accepted result goes at once");
  // Once any reply words are transcribed, they decide; a handoff then is judged on them.
  const q = call();
  q.sent(q.next(jobs, 10_000, false), 10_000);
  q.userSpeech(user("No, what's the weather in Paris?", 5000), 15_000);
  assert.equal(q.acceptUntranscribedReply(15_500), false);
  assert.equal(q.waitingReply(15_500), false, "a real request is handed off as usual");
  // Not waiting for a reply: never.
  assert.equal(call().acceptUntranscribedReply(1000), false);
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  assert.match(live, /const untranscribed = delivery\.acceptUntranscribedReply\(Date\.now\(\)\);\n  if \(untranscribed \|\| delivery\.waitingReply\(Date\.now\(\)\)\) \{/);
});

test("double read judge: diacritics fold, so 'kākāpō' and 'kakapo' are the same key", async () => {
  const { norm } = await import("../../scripts/live-e2e/double-read-judge.mjs");
  assert.equal(norm("The test bird is the kākāpō."), norm("The test bird is the Kakapo."));
  assert.equal(norm("spoon-billed sandpiper"), "spoon billed sandpiper");
});
