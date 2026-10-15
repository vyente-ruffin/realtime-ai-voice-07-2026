// Fix 5 (docs/VOICE-FIX-PLAN.md): let V finish talking. GPT-Live has no turn-detection
// setting, so the fix is the speech instructions; these tests pin that wording and the
// live checks' pass/fail rules (scripts/live-e2e/fix5-judge.mjs) on synthetic fragments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { instructions } from "../../src/live/policy.js";
import { judge } from "../../scripts/live-e2e/fix5-judge.mjs";

const prompt = instructions("", []);
const rule = prompt.match(/Backchannel policy:[^\n]*/)?.[0] || "";

test("5a: the speech rule waits through unfinished words and bans pause acknowledgments", () => {
  assert.ok(rule, "the guide's Backchannel policy heading carries the turn-taking rule");
  assert.match(rule, /^Backchannel policy: No backchannels\. The user often pauses mid-sentence to think; that pause is not your turn, and waiting through it is always right, because they will go on\. Speak only once they have finished a complete thought\./);
  assert.match(rule, /stay silent however long the pause, until they say the rest/);
  for (const cue of ['"uh"', '"and"', '"so"', "half sentence"]) assert.ok(rule.includes(cue), `names ${cue}`);
  assert.match(rule, /stay silent/i);
  assert.match(rule, /"can you check" that hasn't said what yet/, "a request missing its object is unfinished");
  assert.match(rule, /no question about what they want, and no handoff/);
  assert.match(rule, /"Could you look up, um\.\.\." then a pause, then "the weather in Paris" gets one reply, after "Paris"/, "a worked example that is not the test utterance");
  for (const ack of ['"I\'m on it"', '"yeah"', '"sure"', '"hmm"', '"go ahead"', '"I\'m with you"', '"let me take a look"', '"go on"']) assert.ok(rule.toLowerCase().includes(ack.toLowerCase()), `bans ${ack}`);
  assert.doesNotMatch(prompt, /Use brief natural acknowledgments when helpful/, "the old backchannel rule is gone");
});

test("5a/5b: a work acknowledgment comes only once the user has finished", () => {
  assert.match(prompt, /after the user has finished, give one short acknowledgment/);
});

test("5b/5c: once finished, answer once and promptly; another city's time comes from the clock", () => {
  assert.match(rule, /answer once, promptly/i);
  assert.match(prompt, /another city's time/i);
  assert.match(prompt, /Do not delegate to the backend when:[\s\S]*the current date or time, here or in another city/);
});

test("5d: interruption still stops speech at once (Fix 1 wording unchanged)", () => {
  assert.match(prompt, /Interruption policy: Stop your answer immediately when the user interrupts\./);
  assert.match(prompt, /If the user says stop, quiet, enough or shut up, stop speaking and stay silent/);
});

test("the turn-taking rule stays short (plan: keep the instructions short)", () => {
  assert.ok(rule.length <= 850, `rule is ${rule.length} characters`);
});

const f = (role, text, start_ms, at = start_ms) => ({ role, text, start_ms, end_ms: start_ms + 200, at });
const words = [f("user", " So", 4000), f("user", " can you", 4200), f("user", " check", 4600), f("user", ", uh", 4800), f("user", " What", 6600), f("user", " time", 6800), f("user", " in Tokyo", 7400)];

test("judge: a clean run passes 5a, 5b and 5c", () => {
  const v = judge([...words, f("assistant", " It's 8:10", 8400), f("assistant", " a.m.", 8600)], []);
  assert.deepEqual([v.pass5a, v.pass5b, v.pass5c], [true, true, true]);
  assert.equal(v.pauseFrom, 5000);
  assert.equal(v.pauseTo, 6600);
  assert.equal(v.latencyMs, 800);
});

test("judge: speaking in the pause fails 5a; an ack plus a later answer fails 5b", () => {
  const jumped = judge([...words, f("assistant", " I'm on it", 5400), f("assistant", " It's 8:10", 8400)], []);
  assert.equal(jumped.pass5a, false);
  assert.equal(jumped.pass5b, false);
  const acked = judge([...words, f("assistant", " Sure.", 7800), f("assistant", " It's 8:10", 19200)], [{ id: "j" }]);
  assert.equal(acked.pass5a, true);
  assert.equal(acked.pass5b, false, "two responses");
});

test("judge: more than one job fails 5b; a slow answer fails 5c", () => {
  assert.equal(judge([...words, f("assistant", " It's", 8400)], [{ id: "a" }, { id: "b" }]).pass5b, false);
  assert.equal(judge([...words, f("assistant", " It's", 11000)], []).pass5c, false);
});

test("judge: on the 200 ms grid an answer in the last word's slot counts only if received after it", () => {
  const same = judge([...words, f("assistant", " It's 8:10", 7400, 7401)], []);
  assert.equal(same.pass5b, true);
  assert.equal(same.latencyMs, 0);
  assert.equal(same.strictAfter, false, "the strict end_ms reading is reported");
  const early = judge([...words, f("assistant", " Sure", 7400, 7399)], []);
  assert.equal(early.pass5b, false);
});

test("judge: when the transcript lost the words before 'what', the pause is the WAV's 1.5 s before it", () => {
  const lost = words.slice(4);
  const quiet = judge([...lost, f("assistant", " It's 8:10", 8000)], []);
  assert.equal(quiet.pauseFromWav, true);
  assert.deepEqual([quiet.pauseFrom, quiet.pauseTo], [5100, 6600]);
  assert.deepEqual([quiet.pass5a, quiet.pass5b, quiet.pass5c], [true, true, true]);
  const jumped = judge([...lost, f("assistant", " Yeah", 5600), f("assistant", " It's 8:10", 8000)], []);
  assert.equal(jumped.pass5a, false);
  assert.equal(jumped.pass5b, false);
});

test("judge: a reply in the same 200 ms slot as 'uh', received after it, is in the pause", () => {
  const v = judge([...words, f("assistant", " Go ahead", 4800, 4801), f("assistant", " It's 8:10", 8400)], []);
  assert.equal(v.pass5a, false);
  assert.equal(v.pass5b, false);
  const earlier = judge([...words, f("assistant", " Hi", 4800, 4799), f("assistant", " It's 8:10", 8400)], []);
  assert.equal(earlier.assistantInPause.length, 0, "received before 'uh': not a pause reply");
});

test("judge: when the transcript lost 'what', the second part starts at 'time'", () => {
  const noWhat = words.filter((w) => w.text !== " What");
  const v = judge([...noWhat, f("assistant", " Hmm.", 5600), f("assistant", " It's 8:10", 8000)], []);
  assert.equal(v.pauseTo, 6800);
  assert.equal(v.pass5a, false);
});

test("5a/5b: no handoff of an unfinished request", () => {
  assert.match(prompt, /Delegate to the backend, only once the request is complete, when:/);
  assert.match(prompt, /Do not delegate to the backend when:\n- The user has paused mid-request, such as "can you check, uh"; wait for the rest\./);
});

test("5a/5b: the prompt ends with a short turn-taking reminder after the memory and job context", () => {
  const withContext = instructions("\nPrepared memory: likes tea.", [{ id: "j1", state: "running", request: "x" }]);
  assert.match(withContext, /\n\nTurn-taking reminder: at the start of a call say nothing, not even a greeting or the time, until the user speaks first; never start speaking while the user is still talking, even when you can guess their last words, and treat a pause after "uh" or a half sentence as theirs, not yours: wait silently for the rest instead of asking what they want\. Quiet clock and task-status updates are never a cue to speak, even when they arrive while the user is talking\.$/);
  assert.ok(withContext.indexOf("likes tea") < withContext.indexOf("Turn-taking reminder"));
});

test("5b: clock context is never read out unasked (a call-start time announcement ran into V's first words)", () => {
  assert.match(prompt, /Clock updates are silent context, not requests to speak: never say the date or time unless the user asks for it\./);
});

test("judge: a misheard 'So, what can you check' does not move the pause; the 'what' before 'time' does", () => {
  const misheard = [f("user", " So, what can you", 3800), f("user", " check", 4400), f("user", ", uh", 4800), f("user", " What", 6600), f("user", " time", 6800), f("user", " in Tokyo", 7400)];
  const v = judge([...misheard, f("assistant", " Go ahead, what do you want me to check?", 4800, 4801), f("assistant", " It's 8:10", 8400)], []);
  assert.deepEqual([v.pauseFrom, v.pauseTo], [5000, 6600]);
  assert.equal(v.pass5a, false);
  assert.equal(v.pass5b, false);
});
