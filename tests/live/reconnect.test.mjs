/** Fix 7 (docs/VOICE-FIX-PLAN.md): a dropped call never resumes a half-finished answer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryPolicy, CUTOFF_LINE, PAUSE_MS } from "../../web/delivery-policy.js";
import { VoiceStore, liveHistory, markCutOff, CUT_OFF_NOTE } from "../../src/live/store.js";
import { instructions } from "../../src/live/policy.js";
import { verdict7a, verdict7b } from "../../scripts/live-e2e/fix7-judge.mjs";

const out = (delta, start_ms, end_ms = start_ms + 400) => ({ type: "session.output_transcript.delta", delta, start_ms, end_ms });
const user = (delta, start_ms = 0) => ({ type: "session.input_transcript.delta", delta, start_ms, end_ms: start_ms + 200 });
const frag = (session, role, text, start_ms) => ({ session, role, text, start_ms, end_ms: start_ms + 400, at: start_ms });

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-reconnect-"));
  const s = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return s;
}

test("7a: the cut-off answer keeps only whole sentences and is marked cut off in the replayed history", () => {
  assert.equal(markCutOff("The bird is a puffin. It nests on the old"), `The bird is a puffin. ${CUT_OFF_NOTE}`);
  assert.equal(markCutOff("upgrades"), CUT_OFF_NOTE, "a half sentence alone is left out");
  const fragments = [
    frag("s0", "user", "What did I decide?", 0),
    frag("s0", "assistant", "You decided to wait.", 1000),
    frag("s1", "user", "Tell me about the harbor bird.", 0),
    frag("s1", "assistant", "The harbor bird is a puffin. It nests on the old", 3000),
  ];
  const plain = liveHistory(fragments);
  assert.equal(plain.at(-1).content[0].text, "The harbor bird is a puffin. It nests on the old", "no drop recorded: unchanged");
  const history = liveHistory(fragments, new Set(["s1"]));
  assert.equal(history.at(-1).role, "assistant");
  assert.equal(history.at(-1).content[0].text, `The harbor bird is a puffin. ${CUT_OFF_NOTE}`);
  assert.doesNotMatch(history.at(-1).content[0].text, /old$/, "nothing half-said is left to continue");
  assert.equal(history[1].content[0].text, "You decided to wait.", "answers of other sessions are untouched");
  assert.equal(history.length, 4);
});

test("7a/7b: a result cut off mid-read becomes cut_off, is never pushed again, and can be offered once more", (t) => {
  const s = store(t);
  const c = s.createConversation().id;
  const job = s.enqueue(c, "s1", "d1", "user: bird?");
  s.updateJob(job.id, "completed", { result: "The harbor bird is a puffin." });
  const offer = s.offer(s.job(job.id), "s1");
  s.deliveryAck(job.id, "s1", offer.event);
  assert.equal(s.cutOff(c, "other-session", job.id), null, "only the session that was reading it");
  assert.equal(s.delivery(job.id).state, "injected");
  assert.equal(s.cutOff(c, "s1", job.id), job.id);
  assert.equal(s.delivery(job.id).state, "cut_off");
  assert.deepEqual([...s.cutOffSessions(c)], ["other-session", "s1"]);
  const again = s.offer(s.job(job.id), "s2");
  assert.ok(again, "offered again in the reconnected session");
  s.deliveryAck(job.id, "s2", again.event);
  assert.equal(s.delivery(job.id).state, "injected");
  assert.equal(s.offer(s.job(job.id), "s2"), null, "and never a third time");
});

test("7a: after a drop the reconnected session is silent, then offers to finish exactly once", () => {
  const p = new DeliveryPolicy();
  p.joinSession("s1");
  const job = { id: "j1", session: "s1", state: "completed", delivery: "cut_off", updated: 1 };
  p.sent({ kind: "result", job }, 0); // the result was being read when the call dropped
  p.joinSession("s2");
  p.cutOff("j1", 10_000);
  assert.equal(p.next([job], 10_000 + PAUSE_MS - 1, false), null, "nothing straight after reconnect");
  const step = p.next([job], 10_000 + PAUSE_MS, false);
  assert.deepEqual(step, { kind: "cutoff", text: CUTOFF_LINE });
  assert.equal(CUTOFF_LINE, "We got cut off. Want me to finish what I was saying?");
  p.sent(step, 12_000);
  p.assistantSpeech(out("We got cut off.", 0, 2000), 12_100);
  for (let t = 15_000; t < 80_000; t += 200) assert.equal(p.next([job], t, false), null, "one offer, and the cut-off result is never pushed on its own");
});

test("7b: 'yes, finish' brings the cut-off result back in full; a 'no' leaves it unspoken", () => {
  const job = { id: "j1", session: "s1", state: "completed", delivery: "cut_off", updated: 1 };
  const p = new DeliveryPolicy();
  p.joinSession("s1");
  p.joinSession("s2");
  p.cutOff("j1", 0);
  p.sent(p.next([job], 5000, false), 5000);
  p.assistantSpeech(out("We got cut off.", 0, 2000), 5100);
  p.userSpeech(user("Yes, finish.", 3000), 8000);
  assert.equal(p.next([job], 9000, false), null, "the yes is still being said");
  // At once after the yes settles, even while the voice says "Okay": no pause to retell it in.
  const step = p.next([job], 9200, true);
  assert.equal(p.settled, "consent");
  assert.deepEqual(step, { kind: "result", job, resume: true });
  p.sent(step, 11_000);
  assert.equal(p.next([job], 20_000, false), null, "once");

  const q = new DeliveryPolicy();
  q.joinSession("s2");
  q.cutOff("j1", 0);
  q.sent(q.next([job], 5000, false), 5000);
  q.assistantSpeech(out("We got cut off.", 0, 2000), 5100);
  q.userSpeech(user("No, never mind.", 3000), 8000);
  assert.equal(q.next([job], 11_000, false), null);
  assert.equal(q.settled, "declined");
  for (let t = 12_000; t < 60_000; t += 500) assert.equal(q.next([job], t, false), null);
});

test("7b: when the cut-off answer was the model's own, yes asks it to give the whole answer again", () => {
  const p = new DeliveryPolicy();
  p.joinSession("s2");
  p.cutOff(null, 0);
  p.sent(p.next([], 5000, false), 5000);
  p.assistantSpeech(out("We got cut off.", 0, 2000), 5100);
  p.userSpeech(user("Yes, finish.", 3000), 8000);
  const step = p.next([], 11_000, false);
  assert.deepEqual(step, { kind: "finish" });
  p.sent(step, 11_000);
  assert.equal(p.next([], 20_000, false), null);
});

test("7b: the voice handing 'yes, finish' to the backend is answered by the app, not run again", () => {
  const p = new DeliveryPolicy();
  p.joinSession("s2");
  p.cutOff("j1", 0);
  assert.equal(p.cutOffReply(1000), false, "before the offer, a handoff is real work");
  p.sent(p.next([{ id: "j1", session: "s1", state: "completed", delivery: "cut_off", updated: 1 }], 5000, false), 5000);
  p.assistantSpeech(out("We got cut off.", 0, 2000), 5100);
  p.userSpeech(user("Yes, finish.", 3000), 8000);
  assert.equal(p.cutOffReply(8100), true, "a handoff made by the yes, before it settles");
  p.next([], 9200, false);
  assert.equal(p.settled, "consent");
  assert.equal(p.cutOffReply(12_000), true, "and just after");
  assert.equal(p.cutOffReply(20_000), false, "later requests are real work");
  const q = new DeliveryPolicy();
  q.joinSession("s2");
  q.cutOff("j1", 0);
  q.sent(q.next([], 5000, false), 5000);
  q.userSpeech(user("No, check the weather in Paris.", 3000), 8000);
  assert.equal(q.cutOffReply(8100), false, "a different request is handed off as usual");
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  assert.match(live, /if \(delivery\.cutOffReply\(Date\.now\(\)\)\) \{/);
});

test("7c: a stop still silences the offer (Fix 1)", () => {
  const p = new DeliveryPolicy();
  p.joinSession("s2");
  p.userSpeech(user("Stop.", 0), 1000);
  p.cutOff(null, 1000);
  for (let t = 4000; t < 40_000; t += 500) assert.equal(p.next([], t, false), null);
});

test("7a: speech instructions forbid continuing a cut-off answer; the page reports the drop", () => {
  const prompt = instructions("", []);
  assert.match(prompt, /answer marked cut off was interrupted by a dropped connection: never continue, finish, repeat or offer to finish it on your own, and never hand finishing it to the backend/);
  assert.match(prompt, /At the start of a call, stay silent until the user speaks/, "Fix 1 silent connect kept");
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  assert.match(live, /now < speakerUntil \+ 1000 \|\| now - lastAssistantDeltaAt < 2000/);
  assert.match(live, /cutOff: pendingCutOff/);
  assert.match(live, /delivery\.cutOff\(/);
  // A pause between the result's sentences must not end "being read" (a 300 ms gap did, live).
  assert.match(live, /lastSpeakerSample > reading\.at && now > speakerUntil \+ 1500/);
  assert.doesNotMatch(live, /speakerUntil \+ 300\) \{\s*clearInterval\(observer\);\s*if \(readingResult/);
});

/** Real HTTP path: the reconnect's /api/live marks the dropped session's answer in the history it sends. */
test("7a: /api/live with cutOff sends the replayed history with the cut-off answer marked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-reconnect-http-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const config = join(dir, "memory.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://127.0.0.1:1", bank_id: "synthetic" }));
  const child = spawn(process.execPath, ["tests/live/server-fixture.mjs"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VOICE_STATE_PATH: join(dir, "state.sqlite"),
      APPLICATIONINSIGHTS_CONNECTION_STRING: "", VOICE_QUALIFICATION: "1",
      AZURE_OPENAI_ENDPOINT: "https://synthetic.invalid", AZURE_OPENAI_DEPLOYMENT_NAME: "test", HINDSIGHT_CONFIG_PATH: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    try { ready = (await fetch(base + "/healthz")).ok; } catch { await new Promise((r) => setTimeout(r, 20)); }
  }
  assert.ok(ready);
  const token = (await (await fetch(base + "/auth-refresh")).json()).token;
  const post = async (route, body) => (await fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Voice-Auth": token }, body: JSON.stringify(body),
  })).json();
  const conversation = (await post("/api/conversations", { isolated: true })).id;
  const s1 = (await post("/api/live", { conversation, sdp: "v=0" })).session.id;
  await post("/api/transcript", { conversation, session: s1, events: [
    { ...user("Tell me about the harbor bird.", 0), event_id: "u1" },
    { ...out("The harbor bird is a puffin. It nests on the old", 3000), event_id: "a1" },
  ] });
  const forged = (await post("/api/live", { conversation, sdp: "v=0", cutOff: { session: "not-the-active-one" } })).session;
  assert.equal(forged.testHistory.at(-1).content[0].text, "The harbor bird is a puffin. It nests on the old", "only the active session can be reported");
  const s2 = forged.id;
  await post("/api/transcript", { conversation, session: s2, events: [] });
  // The reconnect after s2 dropped mid-answer: s2 said nothing, so s1's turn stays as is; report s2.
  const after = (await post("/api/live", { conversation, sdp: "v=0", cutOff: { session: s2 } })).session;
  assert.equal(after.testHistory.at(-1).content[0].text, "The harbor bird is a puffin. It nests on the old");
  // Now s3 (active) speaks and drops mid-answer.
  const s3 = after.id;
  await post("/api/transcript", { conversation, session: s3, events: [
    { ...user("And the river?", 0), event_id: "u2" },
    { ...out("The test river is the Orinoco. Its gauge sits under an", 2000), event_id: "a2" },
  ] });
  const reconnected = (await post("/api/live", { conversation, sdp: "v=0", cutOff: { session: s3, job: null } })).session;
  assert.equal(reconnected.testHistory.at(-1).content[0].text, `The test river is the Orinoco. ${CUT_OFF_NOTE}`);
  assert.equal(reconnected.testHistory.at(-3).content[0].text, "The harbor bird is a puffin. It nests on the old");
  // A later fresh call still sees it marked.
  const later = (await post("/api/live", { conversation, sdp: "v=0" })).session;
  assert.equal(later.testHistory.at(-1).content[0].text, `The test river is the Orinoco. ${CUT_OFF_NOTE}`);
});

test("judge 7a: silence or the single offer passes; a resumed sentence fails", () => {
  const answer = "The harbor bird is a puffin. It nests on the old lighthouse every spring.";
  const f = (text, at) => ({ role: "assistant", text, at, start_ms: at, end_ms: at + 400 });
  assert.equal(verdict7a({ fragments: [], until: 100, answer }).pass, true);
  assert.equal(verdict7a({ fragments: [f("We got cut off. Want me to finish what I was saying?", 10)], until: 100, answer }).pass, true);
  assert.equal(verdict7a({ fragments: [f("lighthouse every spring.", 10)], until: 100, answer }).pass, false);
  assert.equal(verdict7a({ fragments: [f("It looks like my last reply was cut off. Would you like me to finish it? We got cut off. Want me to finish what I was saying?", 10)], until: 100, answer }).pass, false, "two offers are not the single offer");
  assert.equal(verdict7a({ fragments: [f("Sorry, we got cut off. It nests on the old lighthouse.", 10)], until: 100, answer }).pass, false);
  assert.equal(verdict7a({ fragments: [f("lighthouse every spring.", 200)], until: 100, answer }).pass, true, "after the user spoke is not 7a");
});

test("judge 7b: the key word, 80% of the result's words and a re-delivery after the yes", () => {
  const result = "The harbor bird is a puffin. It nests on the old lighthouse every spring.";
  const delivery = { session: "s2", state: "injected", updated: 50 };
  assert.equal(verdict7b({ spoken: result, result, key: "puffin", delivery, yesAt: 10, session: "s2" }).pass, true);
  assert.equal(verdict7b({ spoken: "The harbor bird is a puffin.", result, key: "puffin", delivery, yesAt: 10, session: "s2" }).pass, false);
  assert.equal(verdict7b({ spoken: result, result, key: "puffin", delivery: { ...delivery, updated: 5 }, yesAt: 10, session: "s2" }).pass, false);
  assert.equal(verdict7b({ spoken: result, result, key: "puffin", delivery, yesAt: 10, session: "s2", early: "Okay." }).pass, true);
  const madeUp = verdict7b({ spoken: result, result, key: "puffin", delivery, yesAt: 10, session: "s2", early: "Okay. The keeper counted nine nests." });
  assert.equal(madeUp.pass, false, "a made-up version before the real result fails");
  const twice = verdict7b({ spoken: `${result} ${result}`, result, key: "puffin", delivery, yesAt: 10, session: "s2" });
  assert.equal(twice.repeats, 2);
  assert.equal(twice.pass, false, "read twice");
  assert.equal(verdict7b({ spoken: result, result, key: "puffin", delivery, yesAt: 10, session: "s2", rerunJobs: 1 }).pass, false, "the finish re-run as a job");
});
