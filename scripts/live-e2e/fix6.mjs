// Fix 6 live checks (docs/VOICE-FIX-PLAN.md, "never claim something it didn't do"). Every call is
// a TestRun (its own test conversation, never the owner's; cleanup.mjs always runs). Pass/fail is
// measured from state.sqlite (fragments, jobs, retention) with the rules in fix6-judge.mjs.
//   node scripts/live-e2e/fix6.mjs 6ac [N]            N calls, each asking 3 questions that need a job (6a + 6c)
//   node scripts/live-e2e/fix6.mjs 6b [N]             N calls: "Remember that my test color is <word>." (6b)
//   node scripts/live-e2e/fix6.mjs judge6ac <conversation>...   re-measure stored 6a/6c calls
// VOICE_E2E_MEMORY=0 runs 6ac calls without the app's memory saves (the old build has no opt-in).
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomInt } from "node:crypto";
import { launch, Call, sleep, until, query, testRun } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { recallText } from "./cleanup.mjs";
import { verdict6ac, verdict6b } from "./fix6-judge.mjs";

const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const [check, ...rest] = process.argv.slice(2);
const out = { check, started: new Date().toISOString(), runs: [] };
const ACTIVE = ["queued", "running", "awaiting_permission"];
export const QUESTIONS = [
  "Is logging enabled on the voice app?",
  "How much free disk space is left on this server?",
  "What's the weather forecast for Seattle tomorrow?",
];
const WORDS = ["periwinkle", "chartreuse", "vermilion", "aubergine", "cerulean", "marigold", "turquoise", "saffron", "magenta", "ochre", "tangerine", "lavender", "sienna", "fuchsia", "mauve"];

const FRAG_SQL = "SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE conversation=? ORDER BY at,rowid";
const JOB_SQL = "SELECT id,state,title,created,updated FROM jobs WHERE conversation=? ORDER BY created";
const SAVE_SQL = "SELECT id,state,content,completed FROM retention WHERE conversation=? ORDER BY rowid";
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const lastAssistant = (c) => query(FRAG_SQL, c).filter((f) => f.role === "assistant").at(-1)?.at ?? 0;

async function quiet(conversation, since, ms, timeout) {
  await until(() => {
    const at = lastAssistant(conversation);
    return Date.now() - Math.max(at, since) > ms;
  }, { timeout, what: "assistant quiet" }).catch(() => null);
}

async function call(run, body) {
  const { browser, context } = await launch(run);
  try {
    const c = await Call.open(context);
    await c.start();
    console.log(`test run ${run.name}, test conversation ${run.conversation}, session ${c.session}`);
    await sleep(4000);
    await body(c, run.conversation);
    await c.end();
    const errors = await c.events("app.error");
    if (errors.length) console.log(`PAGE ERRORS: ${JSON.stringify(errors.map((e) => e.message))}`);
    return run.conversation;
  } finally {
    await browser.close();
  }
}

function printTranscript(conversation) {
  console.log(`SQL: ${FRAG_SQL}  [${conversation}]`);
  let open = null;
  const lines = [];
  for (const f of query(FRAG_SQL, conversation)) {
    if (open && open.role === f.role && f.at - open.last < 1800) {
      open.text += f.text;
      open.last = f.at;
    } else lines.push((open = { role: f.role, text: f.text, at: f.at, last: f.at }));
  }
  for (const l of lines) console.log(`  ${iso(l.at)} ${l.role.padEnd(9)} ${l.text.trim()}`);
}

function judge6ac(conversation, questions) {
  const fragments = query(FRAG_SQL, conversation);
  const jobs = query(JOB_SQL, conversation);
  printTranscript(conversation);
  console.log(`SQL: ${JOB_SQL}  [${conversation}]`);
  for (const j of jobs) console.log(`  job ${j.id} ${j.state} created=${iso(j.created)} updated=${iso(j.updated)} "${j.title}"`);
  if (!questions) {
    // Re-judging a stored call: the questions start where the user fragments of each question begin.
    const users = fragments.filter((f) => f.role === "user");
    questions = users.filter((f, i) => i === 0 || f.at - users[i - 1].at > 8000).map((f) => ({ text: f.text, at: f.at - 3000 }));
  }
  const v = verdict6ac(fragments, jobs, questions);
  console.log(`6a matches for /saved|noted|I'll remember|preference/i: ${v.saves.length}${v.saves.map((s) => `\n  "${s}"`).join("")}`);
  console.log(`6c job claims: ${v.claims.length}`);
  for (const c of v.claims) console.log(`  ${c.pass ? "OK  " : "FAIL"} ${iso(c.at)} [${c.kind}] "${c.text}" -> job ${c.job} created ${iso(c.jobCreated)}`);
  console.log(`VERDICT ${conversation} 6a=${v.pass6a ? "PASS" : "FAIL"} 6c=${v.pass6c ? "PASS" : "FAIL"} jobs=${jobs.length}`);
  return { conversation, jobs: jobs.length, ...v };
}

async function ask(c, conversation, text) {
  const said = await c.say(await speech(text));
  console.log(`${iso(said.startedAt)} SAID: ${text}`);
  await quiet(conversation, said.endedAt, 6000, 45000);
  // Let any job this question started finish and its result be delivered, before the next question.
  await until(() => !query(JOB_SQL, conversation).some((j) => ACTIVE.includes(j.state)), { timeout: 300000, every: 2000, what: "jobs settled" }).catch(() => console.log("jobs still running after 300 s"));
  await quiet(conversation, Date.now(), 10000, 90000);
  return { text, at: said.startedAt };
}

try {
  if (check === "6ac") {
    const n = Number(rest[0] || 5);
    for (let i = 0; i < n; i++) {
      if (i) await sleep(60000);
      const r = await testRun(`fix6-6ac`, async (run) => {
        run.memory = process.env.VOICE_E2E_MEMORY !== "0";
        const questions = [];
        const conversation = await call(run, async (c, conv) => {
          for (const q of QUESTIONS) questions.push(await ask(c, conv, q));
        });
        return judge6ac(conversation, questions);
      });
      out.runs.push({ ...r.result, cleanup: r.cleanup });
    }
  } else if (check === "judge6ac") {
    for (const c of rest) out.runs.push(judge6ac(c));
  } else if (check === "judge6b") {
    // Re-measure stored 6b calls: conversation:word pairs.
    for (const pair of rest) {
      const [conversation, word] = pair.split(":");
      printTranscript(conversation);
      const saves = query(SAVE_SQL, conversation);
      console.log(`SQL: ${SAVE_SQL}  [${conversation}]`);
      for (const s of saves) console.log(`  retention ${s.id} ${s.state} completed=${iso(s.completed)} ${JSON.stringify(s.content)}`);
      const done = saves.find((s) => s.state === "completed" && s.content.toLowerCase().includes(word));
      const v = verdict6b(query(FRAG_SQL, conversation), done?.completed ?? null);
      for (const c of v.claims) console.log(`  ${c.pass ? "OK  " : "FAIL"} ${iso(c.at)} [${c.kind}] "${c.text}" afterCompletion=${c.afterCompletion}`);
      console.log(`VERDICT ${conversation} word=${word} saveCompleted=${iso(done?.completed)} claims=${v.claims.length} claimsPass=${v.pass}`);
      out.runs.push({ conversation, word, claims: v.claims, pass: Boolean(done) && v.pass });
    }
  } else if (check === "6b") {
    const n = Number(rest[0] || 3);
    for (let i = 0; i < n; i++) {
      if (i) await sleep(60000);
      // A plain word: digits are transcribed as spoken numbers ("indigo sixty seven").
      const word = WORDS.splice(randomInt(WORDS.length), 1)[0];
      const r = await testRun(`fix6-6b`, async (run) => {
        run.memory = true;
        run.words.push(word);
        const sentence = `Remember that my test color is ${word}.`;
        let saidAt = 0;
        const conversation = await call(run, async (c, conv) => {
          saidAt = (await c.say(await speech(sentence))).startedAt;
          console.log(`${iso(saidAt)} SAID: ${sentence}`);
          await quiet(conv, saidAt + 4000, 6000, 45000);
          const saved = await until(() => query(SAVE_SQL, conv).find((s) => s.state === "completed" && s.content.toLowerCase().includes(word)), { timeout: 240000, every: 2000, what: "memory save completed" }).catch(() => null);
          console.log(`memory save completed in the app's records: ${iso(saved?.completed)}`);
          // Stay in the call so anything said about the save after it completes is captured.
          await sleep(20000);
          await quiet(conv, Date.now(), 6000, 30000);
        });
        printTranscript(conversation);
        const saves = query(SAVE_SQL, conversation);
        console.log(`SQL: ${SAVE_SQL}  [${conversation}]`);
        for (const s of saves) console.log(`  retention ${s.id} ${s.state} completed=${iso(s.completed)} ${JSON.stringify(s.content)}`);
        const done = saves.find((s) => s.state === "completed" && s.content.toLowerCase().includes(word));
        const v = verdict6b(query(FRAG_SQL, conversation), done?.completed ?? null);
        for (const c of v.claims) console.log(`  ${c.pass ? "OK  " : "FAIL"} ${iso(c.at)} [${c.kind}] "${c.text}" afterCompletion=${c.afterCompletion}`);
        const recalled = await recallText("What is my test color?");
        const found = recalled.toLowerCase().includes(word);
        console.log(`Hindsight recall "What is my test color?" finds "${word}": ${found}`);
        const pass = Boolean(done) && v.pass && found;
        console.log(`VERDICT ${conversation} word=${word} saveCompleted=${iso(done?.completed)} claims=${v.claims.length} recall=${found} 6b=${pass ? "PASS" : "FAIL"}`);
        return { conversation, word, saveCompleted: done?.completed ?? null, claims: v.claims, recall: found, pass };
      });
      out.runs.push({ ...r.result, cleanup: r.cleanup });
    }
  } else throw new Error("Usage: fix6.mjs 6ac [N] | 6b [N] | judge6ac <conversation>...");
} finally {
  out.finished = new Date().toISOString();
  const file = resolve(dir, `fix6-${check}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`\nResults: ${file}`);
  for (const r of out.runs) console.log(`SUMMARY ${r.conversation} ${"pass6a" in r ? `6a=${r.pass6a} 6c=${r.pass6c}` : `6b=${r.pass}`} ownerNewFragments=${r.cleanup?.ownerConversationNewFragments ?? "n/a"}`);
}
