// The normal-conversation fix (docs/evidence/conversation.md): the checks that can be made in code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LanguageGuard, ENGLISH_TEXT, NUDGE_GAP_MS } from "../../web/language.js";
import { instructions } from "../../src/live/policy.js";
import { judgeConvo } from "../../scripts/live-e2e/convo-judge.mjs";

const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");

test("English: the session instructions say to speak English, results and context included", () => {
  assert.match(instructions("", []), /Always speak English, including when you read a task result, a memory or app context, unless the user asks you to speak another language\./);
});

test("English: a result is read in English", () => {
  assert.match(live, /Tell the user its result briefly at a natural pause, once, in English: \$\{job\.result\}/);
});

test("English: Korean or undecodable output sends one trusted instruction, at most every 10 s", () => {
  const g = new LanguageGuard();
  assert.equal(g.assistantSpeech(" It's 2:38 AM in Tokyo.", 0), null);
  assert.equal(g.assistantSpeech("않은데,", 1000), ENGLISH_TEXT);
  assert.equal(g.assistantSpeech(" 그 사이에", 2000), null, "not again within the gap");
  assert.equal(g.assistantSpeech("�", 1000 + NUDGE_GAP_MS), ENGLISH_TEXT, "garbled text counts");
  assert.equal(g.assistantSpeech("Café, naïve, Zürich", 99_000), null, "accented Latin is English text");
});

test("English: a user who asks for another language is not overruled", () => {
  const g = new LanguageGuard();
  g.userSpeech("Can you say that in Korean?");
  assert.equal(g.assistantSpeech("안녕하세요", 0), null);
  const h = new LanguageGuard();
  h.userSpeech("こんにちは");
  assert.equal(h.assistantSpeech("こんにちは", 0), null);
});

test("English: the page sends the guard's instruction as session.instructions.append", () => {
  assert.match(live, /const english = languageGuard\.assistantSpeech\(event\.delta, Date\.now\(\)\);\n\s*if \(english\) append\("session\.instructions\.append", english, null, undefined, "language"\);/);
  const server = readFileSync(new URL("../../src/live/server.js", import.meta.url), "utf8");
  assert.match(server, /"\/web\/language\.js"\]\.includes\(url\.pathname\)/);
  assert.match(server, /\.update\(languageScript\)/, "part of the build id");
});

// The judge, on the records of the Oct 16 calls that failed (texts as stored, start_ms on the
// session audio clock).
const f = (role, text, start_ms) => ({ role, text, start_ms, end_ms: start_ms + 200, at: start_ms });
const marks = { hi: [8000, 9500], p1: [15000, 17000], p2: [20000, 22000], france: [31000, 34000], stop: [65000, 65500], last: [72000, 74500] };
const good = () => [
  f("user", " Hey it going", 8000), f("assistant", " I'm doing great.", 10000),
  f("user", " So can you tell me, uh", 15000), f("user", " What time it is in Tokyo right now", 20000),
  f("assistant", " It's 2:38 AM in Tokyo.", 23000), f("user", " While that's running, what's the capital of France", 31000),
  f("assistant", " Paris.", 35000), f("assistant", " V, this server has 39 GB free.", 54000),
  f("user", " Stop", 65000), f("user", " Okay what were we just talking about", 72000), f("assistant", " Disk space and Paris.", 75000),
];
const tokyo = (at) => new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit" }).format(new Date(at));

test("judge: a clean conversation passes every check", () => {
  const frags = good();
  frags[4] = { ...frags[4], text: ` It's ${tokyo(frags[4].at)} in Tokyo.` };
  const v = judgeConvo({ frags, marks, result: "This server has 39 GB free.", deliveries: [{ state: "played" }] });
  assert.deepEqual(Object.entries(v.checks).filter(([, c]) => !c.pass), []);
  assert.equal(v.pass, true);
});

test("judge: the Oct 16 failures fail their checks", () => {
  const base = () => { const x = good(); x[4] = { ...x[4], text: ` It's ${tokyo(x[4].at)} in Tokyo.` }; return x; };
  let x = base(); x[1] = { ...x[1], text: " 10:39 AM." };
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.hiNoTime.pass, false);
  x = base(); x[7] = { ...x[7], text: " V, 이 서버는 39GB의 여유 공간이 있고" };
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.resultOnceEnglish.pass, false);
  x = base(); x[6] = { ...x[6], text: " What's the capital of Australia? Canberra. Paris." };
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.franceParis.pass, false);
  x = base(); x.splice(9, 0, f("assistant", " Okay, stopping.", 67000));
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.silentAfterStop.pass, false);
  x = base(); x.splice(0, 0, f("assistant", " Hi there.", 3000));
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.silentOnConnect.pass, false);
  x = base(); x.splice(3, 0, f("assistant", " Go ahead.", 18000));
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.silentInPause.pass, false);
  x = base(); x[4] = { ...x[4], text: " It's 9:00 PM in Tokyo." };
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.tokyoTime.pass, false);
  x = base(); x.splice(8, 0, f("assistant", " V, this server has 39 GB free.", 60000));
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.resultOnceEnglish.pass, false, "read twice");
  x = base(); x.pop();
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.afterStopAnswered.pass, false);
});

test("stop: the stop gets only the stop instruction, with no turn-start text or held memory", () => {
  const block = live.slice(live.indexOf("languageGuard.userSpeech(event.delta);"), live.indexOf("if (outcome) {"));
  assert.match(block, /if \(turn && outcome !== "stop"\) append\("session\.instructions\.append", turn\.text/);
  assert.match(block, /do not reply to the stop itself, not even \\"Okay\\" or \\"Okay, stopping\\"\. This is only about the stop: answer the user's next question normally\./);
  assert.match(instructions("", []), /Do not reply to the stop itself, not even "Okay" or "Okay, stopping"\. The user's next question is a new request: answer it normally\./);
});

test("memory refreshes say they are not part of this conversation", async () => {
  const { VoiceMemory } = await import("../../src/live/memory.js");
  const memory = Object.create(VoiceMemory.prototype);
  memory.prepared = [{ id: "current", content: "Facts", refreshed: "now" }];
  assert.match(memory.snapshot()[0].context, /It is background memory, not part of this conversation: the user did not just say or ask any of it\./);
});

test("memory: a refresh is held for the rest of the call, never released while the user speaks", () => {
  assert.match(live, /new MemoryContext\([^;]*\{ holdUntilUser: true \}\)/);
  assert.equal(live.match(/memoryContext\.userSpoke\(\)/g), null, "nothing releases held memory mid-call");
});

test("judge: recapping the result to answer the last question is not a second reading", () => {
  const x = good();
  x[4] = { ...x[4], text: ` It's ${tokyo(x[4].at)} in Tokyo.` };
  x[10] = { ...x[10], text: " You asked about disk space: 39 GB free." };
  const v = judgeConvo({ frags: x, marks, result: "39 GB" });
  assert.equal(v.checks.resultOnceEnglish.pass, true);
  assert.equal(v.checks.resultOnceEnglish.reads, 1);
});

test("status: the start status already in the prompt is not resent, and a greeting is not a status question", () => {
  const started = live.slice(live.indexOf('if (event.type === "session.started") {'), live.indexOf("clockContext.start();", live.indexOf('if (event.type === "session.started") {')));
  assert.match(started, /lastQuietSnapshot = statusContext\(\[\.\.\.jobs\.values\(\)\], Date\.now\(\)\);/);
  assert.doesNotMatch(started, /quietJobs\(\)/);
  assert.match(instructions("", []), /When the user asks how a task is going[^.]*\(a greeting such as "how's it going\?" is small talk, not a status question\)/);
});

test("status: the newest status goes out only when the user asks about status", async () => {
  const { statusQuestion } = await import("../../web/status-context.js");
  for (const q of ["How's it going?", "What are you doing on that?", "Is anything running?", "What happened with that task?",
    "How’s the disk check going?", "Is it done yet?", "Any update?", "How long has it been running?"]) assert.ok(statusQuestion(q), q);
  for (const q of ["What time is it in Tokyo?", "What's the capital of France?", "So can you tell me, uh,", "Stop.",
    "Okay, thanks. What were we just talking about?", "How much free disk space is left on this server?"]) assert.ok(!statusQuestion(q), q);
  assert.equal(live.match(/quietJobs\(true\)/g).length, 1, "the transcript is the only place that sends it");
});

test("judge: a time with the result's number in it is not a reading", () => {
  const x = good();
  x[4] = { ...x[4], text: ` It's ${tokyo(x[4].at)} in Tokyo.` };
  x[1] = { ...x[1], text: " Pretty well." };
  x.splice(5, 0, f("assistant", " It's 1:39 now.", 24000));
  const v = judgeConvo({ frags: x, marks, result: "This server has 39 GB free." });
  assert.equal(v.checks.resultOnceEnglish.reads, 1);
  x[8] = { ...x[8], text: " V, this server has 39 gigabytes free." };
  assert.equal(judgeConvo({ frags: x, marks, result: "39 GB" }).checks.resultOnceEnglish.reads, 1, "spelled-out unit");
});

test("English: Armenian and Bengali (seen live) count as another script; punctuation and digits do not", () => {
  const g = new LanguageGuard();
  assert.equal(g.assistantSpeech(" Paris.աղে", 0), ENGLISH_TEXT);
  assert.equal(new LanguageGuard().assistantSpeech(" Բարեւ", 0), ENGLISH_TEXT, "Armenian alone");
  assert.equal(new LanguageGuard().assistantSpeech(" 80% — it's 5:43 AM; “fine”…", 0), null);
});

test("clock: nothing is sent while the voice speaks", () => {
  const block = live.slice(live.indexOf('if (event.type === "session.output_transcript.delta") {'), live.indexOf("else {", live.indexOf('if (event.type === "session.output_transcript.delta") {')));
  assert.doesNotMatch(block, /clockContext|memoryContext|quietJobs/);
});

test("judge: a reading counts with the number spelled out or 'gigs'", () => {
  for (const said of [" This server has thirty-eight gigabytes free.", " V, this server has 38 gigs free.", " V, 38GB free.", " about 38 GiB of free disk space"]) {
    const x = good();
    x[4] = { ...x[4], text: ` It's ${tokyo(x[4].at)} in Tokyo.` };
    x[7] = { ...x[7], text: said };
    assert.equal(judgeConvo({ frags: x, marks, result: "38 GB free" }).checks.resultOnceEnglish.reads, 1, said);
  }
});
