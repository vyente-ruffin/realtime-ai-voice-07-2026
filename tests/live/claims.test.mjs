/** Fix 6 (docs/VOICE-FIX-PLAN.md): never claim something it didn't do. The parts of 6a-6c
 * that can be checked in code: the speech rule, the app's save confirmation, the save records
 * a spoken "saved" is measured against, and the live-check scoring rules. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { instructions } from "../../src/live/policy.js";
import { VoiceStore } from "../../src/live/store.js";
import { VoiceMemory } from "../../src/live/memory.js";
import { saveConfirmation } from "../../web/status-context.js";
import { madeUpSaves, jobClaims, verdict6ac, verdict6b } from "../../scripts/live-e2e/fix6-judge.mjs";

const prompt = instructions("Prepared memory: likes tea.", []);
const root = resolve(import.meta.dirname, "../..");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-claims-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}
const said = (store, conversation, text, at) =>
  store.db.prepare("INSERT INTO fragments(id,conversation,session,role,text,at,start_ms,end_ms) VALUES(?,?,?,?,?,?,0,0)")
    .run(`${conversation}:${at}`, conversation, "s", "user", text, at);

test("6a/6c: claims come only from this call's app records; no inferred preferences", () => {
  assert.match(prompt, /Claims policy: Say a task started, was handed off or is done, or that something is saved, noted or remembered, only when this call's app records show it\./);
  assert.match(prompt, /A task exists only after your handoff creates it, and it is done only when the app supplies its result or the task status says it ended\./);
  assert.match(prompt, /Never infer a preference, decision or fact the user did not state; a question, a task result or a memory update is not something to remember\./);
  assert.match(prompt, /Never answer a question or a result with "noted", "saved" or "I'll remember"\./);
  // The old vague rule is gone; Fix 1 interruption and Fix 5 turn-taking wording are untouched.
  assert.doesNotMatch(prompt, /Memory saves happen in the background/);
  assert.match(prompt, /Interruption policy: Stop your answer immediately when the user interrupts\./);
  assert.match(prompt, /Quiet clock and task-status updates are never a cue to speak, even when they arrive while the user is talking\.$/);
});

test("6b: a remember request is not handed off; 'saved' only after the app's confirmation", () => {
  assert.match(prompt, /Something is saved only when a "Memory save confirmed by the app" update names the user's words\./);
  assert.match(prompt, /when asked to remember something, do not hand it off; say you're saving it, and never that it is saved before that confirmation\./);
  const line = saveConfirmation("User said:  Remember that my test color is ochre.");
  assert.match(line, /^Memory save confirmed by the app \(silent update, not a request to speak\): the user's own words "Remember that my test color is ochre\." are now saved/);
  assert.match(line, /Do not announce it/);
  assert.ok(saveConfirmation("x".repeat(5000)).length < 600, "the confirmation stays short");
});

test("6b: the browser sends that confirmation per completed save, not the old vague notice", () => {
  const page = readFileSync(join(root, "web/live.js"), "utf8");
  assert.match(page, /if \(event\.saved\) append\("session\.thinking\.append", saveConfirmation\(event\.saved\), null, undefined, "save-confirmation"\);/);
  assert.doesNotMatch(page, /completed memory processing/);
  const server = readFileSync(join(root, "src/live/server.js"), "utf8");
  assert.match(server, /type: "memory\.state", state: state\.state, \.\.\.\(state\.saved \? \{ saved: state\.saved \} : \{\}\)/);
});

test("6b: a completed save records its completion time and names what was saved", async (t) => {
  const { dir, store } = fixture(t);
  const c = store.createConversation().id;
  said(store, c, "Remember that my test color is ochre.", Date.now() - 10000);
  store.queueMemory();
  const configPath = join(dir, "hindsight.json");
  writeFileSync(configPath, JSON.stringify({ api_url: "http://memory.test", bank_id: "synthetic" }));
  const states = [];
  const memory = new VoiceMemory({ configPath, modelIds: [], store, onState: (s) => states.push(s) });
  memory.request = async () => ({});
  await memory.drain(); // sent
  store.db.prepare("UPDATE retention SET next_at=0").run();
  assert.equal(store.db.prepare("SELECT completed FROM retention").get().completed, null, "not complete when merely submitted");
  memory.request = async () => ({ status: "completed" });
  const before = Date.now();
  await memory.drain();
  const row = store.db.prepare("SELECT state,completed FROM retention").get();
  assert.equal(row.state, "completed");
  assert.ok(row.completed >= before && row.completed <= Date.now());
  const done = states.at(-1);
  assert.equal(done.state, "saved");
  assert.match(done.saved, /my test color is ochre/);
  assert.equal(states.filter((s) => s.saved).length, 1, "only a completed save carries a confirmation");
});

test("6b isolation: test calls save memory only when the run opts in (cleanup invalidates it)", (t) => {
  const { store } = fixture(t);
  const plain = store.createConversation("fix6-unit").id;
  const saving = store.createConversation("fix6-unit", { memory: true }).id;
  const ownerOptIn = store.createConversation(null, { memory: true }).id;
  for (const c of [plain, saving]) said(store, c, `words in ${c}`, Date.now() - 10000);
  store.queueMemory();
  const rows = store.db.prepare("SELECT conversation FROM retention").all().map((r) => r.conversation);
  assert.deepEqual(rows, [saving]);
  assert.equal(store.conversation(ownerOptIn).test_memory, 0, "the opt-in exists only for test conversations");
  // Opted-in test speech still never reaches the owner's prompt history.
  assert.doesNotMatch(store.recentUserStatements(), /words in/);
});

const f = (role, text, at) => ({ role, text, at, start_ms: 0, end_ms: 0 });

test("judge 6a: the plan's pattern, including curly apostrophes", () => {
  assert.deepEqual(madeUpSaves([f("assistant", "Logging is on.", 1)]), []);
  assert.equal(madeUpSaves([f("assistant", "Got it—I’ve saved that preference.", 1)]).length, 2);
  assert.equal(madeUpSaves([f("assistant", "Noted.", 1)]).length, 1);
  assert.equal(madeUpSaves([f("assistant", "I’ll remember", 1)]).length, 1);
  assert.equal(madeUpSaves([f("user", "my preference is tea", 1)]).length, 0, "user speech is not scored");
});

test("judge 6c: a start claim needs a job created before it in its question; a done claim an ended job", () => {
  const questions = [{ text: "q1", at: 1000 }, { text: "q2", at: 50000 }];
  const job = { id: "j1", state: "completed", created: 3000, updated: 30000 };
  // Claim after the job was created: matched.
  let claims = jobClaims([f("assistant", "I'm checking the logging setup now.", 3500)], [job], questions);
  assert.deepEqual(claims.map((c) => [c.kind, c.pass]), [["started", true]]);
  // Claim before any job row exists: fails.
  claims = jobClaims([f("assistant", "I'm checking that.", 2500)], [job], questions);
  assert.equal(claims[0].pass, false);
  // A start claim in the second question cannot reuse the first question's finished job.
  claims = jobClaims([f("assistant", "Let me check the forecast.", 51000)], [job], questions);
  assert.equal(claims[0].pass, false);
  // Done before the job ended fails; after it ended passes.
  assert.equal(jobClaims([f("assistant", "Done, it's enabled.", 20000)], [job], questions)[0].pass, false);
  assert.equal(jobClaims([f("assistant", "Done, it's enabled.", 31000)], [job], questions)[0].pass, true);
  // Other phrasings heard in live calls count as start claims too.
  for (const said of ["Good question. I'll go check.", "Let's get that.", "Let me take a quick look."])
    assert.equal(jobClaims([f("assistant", said, 2500)], [job], questions)[0]?.kind, "started", said);
  // Plain answers are not claims.
  assert.equal(jobClaims([f("assistant", "Logging is enabled.", 31000)], [job], questions).length, 0);
  const v = verdict6ac([f("assistant", "I'm on it.", 3200), f("assistant", "Logging is enabled.", 31000)], [job], questions);
  assert.deepEqual([v.pass6a, v.pass6c], [true, true]);
});

test("judge 6b: 'saved' must follow the recorded completion; 'saving' is always honest", () => {
  const completed = 10000;
  assert.equal(verdict6b([f("assistant", "Okay, saving that.", 5000)], completed).pass, true);
  assert.equal(verdict6b([f("assistant", "Got it, I've saved that.", 5000)], completed).pass, false);
  assert.equal(verdict6b([f("assistant", "It's saved.", 12000)], completed).pass, true);
  assert.equal(verdict6b([f("assistant", "It's saved.", 12000)], null).pass, false, "no completion record: never saved");
  // Phrasings heard in live calls: a promise or "remembering" is saving, not saved.
  for (const said of ["I'll remember that your test color is saffron.", "I'm remembering that your test color is mauve."])
    assert.deepEqual(verdict6b([f("assistant", said, 5000)], completed).claims.map((c) => [c.kind, c.pass]), [["saving", true]], said);
});
