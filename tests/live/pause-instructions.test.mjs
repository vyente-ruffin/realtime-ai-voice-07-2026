/** Fix 5: a trusted session.instructions.append tells the voice to let V finish when the words so
 * far end on a filler. Nothing goes out at a turn's first words: an instruction sent while the user
 * talks made the voice miss the next ~0.5 s of their speech (conversation fix, Oct 16). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnTaking, unfinished, UNFINISHED_TEXT } from "../../web/turn-taking.js";

const user = (delta) => ({ type: "session.input_transcript.delta", delta });

test("5a: nothing is sent while the user talks: no instruction at a turn's first words", () => {
  const t = new TurnTaking();
  assert.equal(t.userSpeech(user(" So can"), 1000), null);
  assert.equal(t.userSpeech(user(" you"), 1050), null);
  assert.equal(t.userSpeech(user(" check"), 1300), null);
  assert.equal(t.userSpeech(user(" Hey Jarvis, how's it going?"), 1400), null);
});

test("5a: a trailing filler gets one instruction per turn, at least 600 ms after the first words", () => {
  const t = new TurnTaking();
  t.userSpeech(user(" So can"), 1000);
  t.userSpeech(user(" you"), 1050);
  assert.equal(t.userSpeech(user(" check"), 1700), null, "a half sentence alone does not");
  assert.equal(t.userSpeech(user(", uh"), 2400)?.kind, "unfinished");
  // The 1.5 s pause plus transcript lag is still the same turn: no second instruction.
  assert.equal(t.userSpeech(user(" What time it is in"), 5200), null, "joining words near the end do not fire");
  assert.equal(t.userSpeech(user(" Tokyo"), 5900), null);
  // After the voice answered, the next words are a new turn.
  t.assistantSpeech();
  t.userSpeech(user(" So"), 9000);
  assert.equal(t.userSpeech(user(" um"), 9700)?.kind, "unfinished", "a new turn gets its own");
});

test("5a: only the voice speaking or 10 s of no words starts a new turn; empty deltas are ignored", () => {
  const t = new TurnTaking();
  assert.equal(t.userSpeech(user(" "), 1000), null);
  assert.equal(t.turn.startedAt, null, "empty deltas do not start the turn");
  t.userSpeech(user("Hello"), 1100);
  const first = t.turn;
  t.userSpeech(user(" there"), 4000);
  assert.equal(t.turn, first, "a 3 s pause is not a new turn");
  t.userSpeech(user(" again"), 15000);
  assert.notEqual(t.turn, first, "after 10 s with no words it is");
});

test("5a: what counts as a trailing filler", () => {
  for (const s of ["So can you check, uh", "um", "So...", "check, uh,", "Hmm", "So can you ah", "uhm"]) assert.ok(unfinished(s), s);
  for (const s of ["What time is it in Tokyo?", "So can you check", "what's the weather in", "Stop.", "Yes, tell me."]) assert.ok(!unfinished(s), s);
});

test("5a: the instructions stay short and never ask for an acknowledgment", () => {
  for (const text of [UNFINISHED_TEXT]) {
    assert.ok(text.length < 300, "one short sentence or two");
    assert.match(text, /silent/);
    assert.doesNotMatch(text, /answer at once/, "pushed the voice into prefacing and handing off (seen live)");
  }
});

test("5a: the page sends the instruction as session.instructions.append before any quiet context, and the server serves the module", async () => {
  const { readFileSync } = await import("node:fs");
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../src/live/server.js", import.meta.url), "utf8");
  assert.match(live, /languageGuard\.userSpeech\(event\.delta\);\n      const turn = turnTaking\.userSpeech\(event, Date\.now\(\)\);\n      const outcome = delivery\.userSpeech\(event, Date\.now\(\)\);\n(?:\s*\/\/.*\n)*      if \(turn && outcome !== "stop"\) append\("session\.instructions\.append", turn\.text, null, undefined, "turn-taking"\);\n/);
  assert.match(live, /turnTaking\.assistantSpeech\(\);/);
  assert.match(server, /"\/web\/turn-taking\.js"(?:, "[^"]+")*\]\.includes\(url\.pathname\)/);
  assert.match(server, /\.update\(turnScript\)/, "part of the build id");
});

test("5b: a plain time question handed off is answered by the app from the browser clock, not Hermes", async () => {
  const { clockQuestion } = await import("../../web/clock-context.js");
  for (const s of [" So can you Uh What time is it in Tokyo", "So can you check, uh, what time it is in Tokyo.", "What's the date today?", "what time is it"]) assert.ok(clockQuestion(s), s);
  for (const s of ["Remind me at what time the meeting is", "What's the weather in Tokyo?", "Is logging enabled on the voice app?", "Set a timer for what time it is now plus ten minutes", "Check the disk space"]) assert.ok(!clockQuestion(s), s);
  const { readFileSync } = await import("node:fs");
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  const delegate = live.slice(live.indexOf("async function delegate(event)"), live.indexOf("async function handle("));
  assert.ok(delegate.indexOf("clockQuestion(said)") < delegate.indexOf('api("/api/delegations"'), "checked before any job is created");
  assert.match(delegate, /"session\.thinking\.append",\n\s*`No backend task: this is a date or time question\.[^`]*\$\{clockSnapshot\(\)\.context\}`,\n\s*delegation\.id,/);
  assert.match(delegate, /auditApp\("delegation\.clock_reply", \{ delegation: delegation\.id \}\)/);
});

test("stop ends the turn, so the next question is a new turn with its own reply watchdog", async () => {
  const { REPLY_WAIT_MS, REPLY_TEXT } = await import("../../web/turn-taking.js");
  const t = new TurnTaking();
  t.userSpeech(user(" Stop."), 1000);
  t.endTurn();
  assert.equal(t.replyDue(1000 + REPLY_WAIT_MS), null, "the stop itself is never nudged");
  t.userSpeech(user(" What were we talking about?"), 6000);
  assert.equal(t.replyDue(6000 + REPLY_WAIT_MS), REPLY_TEXT);
});

test("no turn-taking text mentions the time (a turn-start text that did made the voice say it unasked)", async () => {
  const { REPLY_TEXT } = await import("../../web/turn-taking.js");
  for (const text of [UNFINISHED_TEXT, REPLY_TEXT]) assert.doesNotMatch(text, /time|clock/i);
});

test("reply watchdog: a finished question with no reply in 2.5 s gets one 'answer now' instruction", async () => {
  const { REPLY_WAIT_MS, REPLY_TEXT } = await import("../../web/turn-taking.js");
  const t = new TurnTaking();
  t.userSpeech(user(" Hey Jarvis, how's it going?"), 1000);
  assert.equal(t.replyDue(1000 + REPLY_WAIT_MS - 1), null, "not before 2.5 s");
  assert.equal(t.replyDue(1000 + REPLY_WAIT_MS), REPLY_TEXT);
  assert.equal(t.replyDue(1000 + 2 * REPLY_WAIT_MS), null, "once per turn");
  assert.doesNotMatch(REPLY_TEXT, /time|clock/i);
});

test("reply watchdog: never after a stop, an 'uh', a handoff, a reply, or words with no question", () => {
  const due = (setup) => { const t = new TurnTaking(); setup(t); return t.replyDue(99_000); };
  assert.equal(due((t) => { t.userSpeech(user(" Stop."), 1000); t.endTurn(); }), null);
  assert.equal(due((t) => t.userSpeech(user(" So can you tell me, uh,"), 1000)), null);
  assert.equal(due((t) => { t.userSpeech(user(" What's the weather in Paris?"), 1000); t.delegated(); }), null);
  assert.equal(due((t) => { t.userSpeech(user(" What's the capital of France?"), 1000); t.assistantSpeech(); }), null);
  assert.equal(due((t) => t.userSpeech(user(" Yes, tell me."), 1000)), null);
});

test("reply watchdog: the page re-arms it on every user word and sends it as session.instructions.append", async () => {
  const { readFileSync } = await import("node:fs");
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  assert.match(live, /clearTimeout\(replyTimer\);\n\s*replyTimer = setTimeout\(replyCheck, REPLY_WAIT_MS \+ 50\);/);
  assert.match(live, /const nudge = turnTaking\.replyDue\(Date\.now\(\)\);\n\s*if \(nudge\) append\("session\.instructions\.append", nudge, null, undefined, "turn-taking"\);/);
  assert.match(live, /event\.type === "session\.delegation\.created"\) \{\n\s*turnTaking\.delegated\(\);/);
});
