/** Fix 5 (Part 3): a trusted session.instructions.append tells the voice to let V finish, sent at
 * the first words of each user turn and again when the words so far are unfinished. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnTaking, unfinished, START_TEXT, UNFINISHED_TEXT } from "../../web/turn-taking.js";

const user = (delta) => ({ type: "session.input_transcript.delta", delta });

test("5a: the first words of a turn get the let-them-finish instruction, once", () => {
  const t = new TurnTaking();
  assert.deepEqual(t.userSpeech(user(" So can"), 1000), { kind: "start", text: START_TEXT });
  assert.equal(t.userSpeech(user(" you"), 1050), null, "not again in the same breath");
  assert.equal(t.userSpeech(user(" check"), 1300), null);
});

test("5a: a trailing filler gets one more instruction per turn, at least 600 ms after the start", () => {
  const t = new TurnTaking();
  t.userSpeech(user(" So can"), 1000);
  t.userSpeech(user(" you"), 1050);
  assert.equal(t.userSpeech(user(" check"), 1700), null, "a half sentence alone does not");
  assert.equal(t.userSpeech(user(", uh"), 2400)?.kind, "unfinished");
  // The 1.5 s pause plus transcript lag is still the same turn: no second start instruction.
  assert.equal(t.userSpeech(user(" What time it is in"), 5200), null, "joining words near the end do not fire");
  assert.equal(t.userSpeech(user(" Tokyo"), 5900), null);
  // After the voice answered, the next words are a new turn.
  t.assistantSpeech();
  assert.equal(t.userSpeech(user(" Thanks."), 9000)?.kind, "start");
});

test("5a: only the voice speaking or 10 s of no words starts a new turn; empty deltas are ignored", () => {
  const t = new TurnTaking();
  assert.equal(t.userSpeech(user(" "), 1000), null);
  assert.equal(t.userSpeech(user("Hello"), 1100)?.kind, "start");
  assert.equal(t.userSpeech(user(" there"), 4000), null, "a 3 s pause is not a new turn");
  assert.equal(t.userSpeech(user(" again"), 15000)?.kind, "start", "after 10 s with no words it is");
});

test("5a: what counts as a trailing filler", () => {
  for (const s of ["So can you check, uh", "um", "So...", "check, uh,", "Hmm", "So can you ah", "uhm"]) assert.ok(unfinished(s), s);
  for (const s of ["What time is it in Tokyo?", "So can you check", "what's the weather in", "Stop.", "Yes, tell me."]) assert.ok(!unfinished(s), s);
});

test("5a: the instructions stay short and never ask for an acknowledgment", () => {
  for (const text of [START_TEXT, UNFINISHED_TEXT]) {
    assert.ok(text.length < 300, "one short sentence or two");
    assert.match(text, /silent/);
    assert.doesNotMatch(text, /answer at once/, "pushed the voice into prefacing and handing off (seen live)");
  }
});

test("5a: the page sends the instruction as session.instructions.append before any quiet context, and the server serves the module", async () => {
  const { readFileSync } = await import("node:fs");
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../src/live/server.js", import.meta.url), "utf8");
  assert.match(live, /const turn = turnTaking\.userSpeech\(event, Date\.now\(\)\);\n      if \(turn\) append\("session\.instructions\.append", turn\.text, null, undefined, "turn-taking"\);\n      memoryContext\.userSpoke\(\);/);
  assert.match(live, /turnTaking\.assistantSpeech\(\);/);
  assert.match(server, /"\/web\/turn-taking\.js"\]\.includes\(url\.pathname\)/);
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
