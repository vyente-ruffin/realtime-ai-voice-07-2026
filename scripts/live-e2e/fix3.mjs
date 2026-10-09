// Fix 3 live checks (docs/VOICE-FIX-PLAN.md): answers about the user come from real
// memory, quickly, in context. Every run is a TestRun: its calls use their own test
// conversation (never the owner's), and cleanup.mjs invalidates every memory the run
// created. Pass/fail timing comes from state.sqlite fragments; each spoken answer is
// printed next to a Hindsight recall on bank `hermes` for the same question. No facts
// about the user live here: questions come from the plan, test words are random.
//   node scripts/live-e2e/fix3.mjs isolation   prove a test run leaves no trace in the owner's conversation or memory
//   node scripts/live-e2e/fix3.mjs sessions <run ids>   status, time and size of earlier Hermes runs (the before side)
//   node scripts/live-e2e/fix3.mjs effort [efforts]     one delegated memory question per reasoning effort, straight to the Runs API
//   node scripts/live-e2e/fix3.mjs 3a          the four 3a questions plus the 3d follow-up, one call
//   node scripts/live-e2e/fix3.mjs 3b          tell a fresh word with `hermes -z`, wait 10 minutes, ask voice for it
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, turns, testRun } from "./harness.mjs";
import { hermesOneshot } from "./cleanup.mjs";
import { hermesKey } from "../../src/live/worker.js";
import { speech } from "./tts.mjs";
import { getLogger } from "../../src/core/logger.js";

const logger = await getLogger("live-e2e.fix3");
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const check = process.argv[2];
const out = { check, started: new Date().toISOString(), sessions: [], questions: [] };
const LIMIT_MS = 10000;
// A waiting preface is not the answer (plan 3c: a "one sec" acknowledgement doesn't count).
const PREFACE = /^\W*(one sec|one moment|just a (sec|moment)|hold on|let me (check|look|see|pull)|checking|give me a (sec|moment)|looking)/i;

const hindsight = JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG_PATH || resolve(process.env.HOME, ".hermes/hindsight/config.json"), "utf8"));
async function recall(text) {
  const r = await fetch(`${hindsight.api_url}/v1/default/banks/${hindsight.bank_id}/memories/recall`, {
    method: "POST",
    headers: { Authorization: `Bearer ${hindsight.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: text, budget: "mid", max_tokens: 2048 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) return { http: r.status, error: await r.text() };
  const body = await r.json();
  return (body.results || []).slice(0, 12).map((m) => `${m.occurred_start || m.mentioned_at || ""} | ${m.text}`);
}

/** Quoted questions in a check's row of docs/VOICE-FIX-PLAN.md. */
function planQuestions(id) {
  const plan = readFileSync(resolve(import.meta.dirname, "../../docs/VOICE-FIX-PLAN.md"), "utf8");
  const row = plan.split("\n").find((l) => l.startsWith(`| ${id} |`));
  return [...row.matchAll(/"([^"]+\?)"/g)].map((m) => m[1]);
}
const rows = (session, since) => query("SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND at>=? ORDER BY at,rowid", session, since);
const jobsSince = (session, since) =>
  query("SELECT j.id,j.state,j.run_id,j.created,j.updated,substr(j.request,1,200) AS request,substr(j.result,1,400) AS result,d.state AS delivery,d.updated AS delivered FROM jobs j LEFT JOIN deliveries d ON d.job=j.id WHERE j.session=? AND j.created>=? ORDER BY j.created", session, since);

/** Speak one question, wait until the reply has finished, then time it from fragments. */
async function ask(call, text) {
  const said = await call.say(await speech(text));
  const since = said.startedAt;
  const settled = () => {
    const r = rows(call.session, since);
    const lastAssistant = r.filter((x) => x.role === "assistant").at(-1);
    const jobs = jobsSince(call.session, since);
    const pending = jobs.some((j) => !["completed", "failed", "cancelled", "interrupted"].includes(j.state) || (j.state === "completed" && j.delivery !== "injected"));
    // A delivered result must also have been spoken: wait for speech after the delivery.
    const delivered = Math.max(0, ...jobs.filter((j) => j.delivery === "injected").map((j) => j.delivered));
    return lastAssistant && !pending && lastAssistant.at > delivered && Date.now() - lastAssistant.at > 8000;
  };
  await until(settled, { timeout: 120000, every: 500, what: `reply to ${JSON.stringify(text)}` }).catch(() => null);
  const r = rows(call.session, since);
  const jobs = jobsSince(call.session, since);
  const user = r.filter((x) => x.role === "user");
  const questionEnd = user.length ? user.at(-1) : null;
  // The actual answer: after a delivered job result when the question was handed to Hermes;
  // otherwise the first assistant turn that is not a waiting preface.
  const assistantTurns = turns(call.session).filter((t) => t.role === "assistant" && t.at >= since);
  const injected = jobs.find((j) => j.delivery === "injected");
  let answer = assistantTurns.find((t) => !PREFACE.test(t.text));
  if (injected) {
    // The first words spoken after the result reached the voice.
    const first = r.find((x) => x.role === "assistant" && x.at >= injected.delivered);
    answer = first && { ...first, text: r.filter((x) => x.role === "assistant" && x.at >= first.at).map((x) => x.text).join("") };
  }
  // The question ends when its audio ends (said.endedAt, same clock as fragments.at). GPT-Live
  // sends the user transcript with the reply, so the user fragment's own `at` is reported but
  // the earlier audio end is used for pass/fail: the stricter of the two.
  const end = questionEnd ? Math.min(questionEnd.at, said.endedAt) : said.endedAt;
  const latency = answer ? answer.at - end : null;
  const audioLatency = questionEnd && answer ? answer.start_ms - questionEnd.end_ms : null;
  const entry = {
    question: text,
    saidEnded: new Date(said.endedAt).toISOString(),
    saidEndedAt: said.endedAt,
    questionEndFragment: questionEnd,
    answerStart: answer ? { at: answer.at, start_ms: answer.start_ms } : null,
    latencyMs: latency,
    audioClockLatencyMs: audioLatency,
    pass: latency !== null && latency <= LIMIT_MS,
    spoken: assistantTurns.map((t) => t.text).join(" | "),
    answer: answer?.text ?? null,
    jobs,
    fragments: r,
    recall: await recall(text),
  };
  out.questions.push(entry);
  logger.info("question timed", { question: text, latencyMs: latency, jobs: jobs.length });
  console.log(`\n--- Q: ${text}\nquestion audio ended at=${said.endedAt} (${new Date(said.endedAt).toISOString()}); last user fragment at=${questionEnd?.at}\nanswer start at=${answer?.at} (${answer && new Date(answer.at).toISOString()})\nlatency(answer fragments.at - question end)=${latency} ms; latency(audio clock)=${audioLatency} ms; jobs=${jobs.length}\nASSISTANT: ${entry.spoken}\nHINDSIGHT RECALL (bank ${hindsight.bank_id}):\n  ${Array.isArray(entry.recall) ? entry.recall.join("\n  ") : JSON.stringify(entry.recall)}`);
  return entry;
}


const WORDS = ["marmalade", "tamarind", "periwinkle", "quillwort", "bergamot", "juniper", "tangerine", "sassafras", "lapwing", "kestrel", "cormorant", "chickadee", "nightjar", "wagtail", "pumpernickel", "buttercup"];
/** A word with no trace in memory yet, so finding it later proves where it came from. */
async function freshWord(exclude = []) {
  for (const w of WORDS.slice().sort(() => Math.random() - 0.5)) {
    if (exclude.includes(w)) continue;
    const q = new URLSearchParams({ q: w, limit: "5" });
    const found = await fetch(`${hindsight.api_url}/v1/default/banks/${hindsight.bank_id}/memories/list?${q}`, {
      headers: { Authorization: `Bearer ${hindsight.api_key}` }, signal: AbortSignal.timeout(30000),
    }).then((r) => r.json());
    const invalid = await fetch(`${hindsight.api_url}/v1/default/banks/${hindsight.bank_id}/memories/list?${q}&state=invalidated`, {
      headers: { Authorization: `Bearer ${hindsight.api_key}` }, signal: AbortSignal.timeout(30000),
    }).then((r) => r.json());
    if (!found.items.length && !invalid.items.length) return w;
  }
  throw new Error("No unused test word left.");
}
const hermesUrl = process.env.HERMES_API_URL || "http://10.69.3.175:8642";
async function hermesRun(id) {
  const r = await fetch(`${hermesUrl}/v1/runs/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${hermesKey()}` }, signal: AbortSignal.timeout(10000) });
  return r.ok ? r.json() : { http: r.status };
}
const runSummary = (r) => ({ run: r.run_id, session: r.session_id, status: r.status, seconds: r.updated_at && r.created_at ? +(r.updated_at - r.created_at).toFixed(1) : null, inputTokens: r.usage?.input_tokens, output: String(r.output || "").slice(0, 120) });

async function oneCall(run, body) {
  const { browser, context } = await launch(run);
  try {
    const call = await Call.open(context);
    out.sessions.push(await call.start());
    out.conversation = run.conversation;
    console.log(`test run ${run.name}, test conversation ${run.conversation}, session ${call.session}`);
    await sleep(4000);
    await body(call);
    await call.end();
    out.transcript = turns(call.session);
    out.jobs = query("SELECT id,state,run_id,hermes_session,created,updated,substr(result,1,300) AS result FROM jobs WHERE session=?", call.session);
    for (const j of out.jobs) if (j.run_id) j.hermes = runSummary(await hermesRun(j.run_id));
    console.log(`\nTRANSCRIPT (fragments joined per speaker):\n${out.transcript.map((t) => `${new Date(t.at).toISOString()} ${t.role}: ${t.text}`).join("\n")}\nJOBS: ${JSON.stringify(out.jobs, null, 1)}`);
    return call;
  } finally {
    await browser.close();
  }
}
const timing = (sql, session) => {
  const times = out.questions.map((q) => ({ question: q.question, latencyMs: q.latencyMs, audioClockLatencyMs: q.audioClockLatencyMs, pass: q.pass }));
  console.log(`\n=== 3c ${times.every((t) => t.pass) ? "PASS" : "FAIL"} (limit ${LIMIT_MS} ms)\nSQL: ${sql}\nARGS: ${JSON.stringify([session])}\n${JSON.stringify(times, null, 1)}`);
};
const SQL = "SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND at>=? ORDER BY at,rowid";

try {
  if (check === "isolation") {
    const { cleanup } = await testRun("fix3-iso", async (run) => {
      const voiceWord = await freshWord();
      const cliWord = await freshWord([voiceWord]);
      run.words.push(voiceWord, cliWord);
      out.words = { voiceWord, cliWord };
      console.log(`test words: voice=${voiceWord} oneshot=${cliWord}`);
      // A Hermes run that is retained into memory (auto-retain), and a `hermes -z` memory save.
      console.log(`hermes -z: ${hermesOneshot(run.name, `Remember this: my isolation probe word is ${cliWord}.`)}`);
      await oneCall(run, async (call) => {
        await ask(call, `Please search my notes for the word ${voiceWord}.`);
      });
      out.hermesRetainedBeforeCleanup = query("SELECT DISTINCT hermes_session FROM jobs WHERE conversation=?", run.conversation);
    });
    out.cleanup = cleanup;
    const owner = JSON.parse(query("SELECT value FROM cache WHERE key='default-conversation'")[0].value);
    const ownerSql = "SELECT COUNT(*) AS n FROM fragments WHERE conversation=? AND at>=?";
    const ownerRows = query(ownerSql, owner, Date.parse(out.started));
    const testRows = query("SELECT COUNT(*) AS n FROM fragments WHERE conversation=?", out.conversation);
    const recallHits = Object.values(cleanup.recallHitsForTestWords).reduce((a, b) => a + b, 0);
    const pass = ownerRows[0].n === 0 && cleanup.ownerConversationNewFragments === 0 && recallHits === 0 && testRows[0].n > 0 &&
      Object.values(cleanup.stillValidPerSession).every((n) => n === 0) && Object.values(cleanup.preparedMemoryHitsForTestWords).every((h) => !h.length) && cleanup.hermesMemoryFileHits.length === 0;
    console.log(`\n=== isolation ${pass ? "PASS" : "FAIL"}\nSQL: ${ownerSql}\nARGS: ${JSON.stringify([owner, Date.parse(out.started)])}\nOWNER ROWS: ${JSON.stringify(ownerRows)}\nTEST CONVERSATION FRAGMENTS: ${JSON.stringify(testRows)}\nRECALL HITS FOR TEST WORDS: ${JSON.stringify(cleanup.recallHitsForTestWords)}`);
  } else if (check === "sessions") {
    // Before: runs of the owner's voice conversation on its single long-lived Hermes session
    // (run ids recorded by the earlier attempt's logs; read-only status lookups).
    const ids = [...new Set(process.argv.slice(3))];
    const before = [];
    for (const id of ids) before.push(runSummary(await hermesRun(id)));
    out.before = before.filter((r) => r.status === "completed");
    console.log(`BEFORE (one Hermes session per voice conversation):\n${JSON.stringify(out.before, null, 1)}`);
  } else if (check === "effort") {
    // Same delegated memory question straight to the Runs API, per reasoning effort (documented
    // request-scoped `model_options`), each in its own fresh test session; cleanup covers them.
    const { VoiceMemory } = await import("../../src/live/memory.js");
    const { VoiceStore } = await import("../../src/live/store.js");
    const { workerInstructions } = await import("../../src/live/policy.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const scratch = new VoiceStore(resolve(mkdtempSync(resolve(tmpdir(), "fix3-effort-")), "s.sqlite"));
    const mem = new VoiceMemory({ configPath: resolve(process.env.HOME, ".hermes/hindsight/config.json"), store: scratch });
    const [followUp, lead] = planQuestions("3d");
    const input = `user: ${lead}\nassistant: (answered from memory)\nuser: ${followUp}`;
    const efforts = (process.argv[3] || "default,medium,low").split(",");
    const sessions = [];
    const { cleanup } = await testRun("fix3-effort", async (run) => {
      out.effort = [];
      for (const effort of efforts) {
        const session = `voice-e2e-${run.name}-${effort}`;
        sessions.push(session);
        const t0 = Date.now();
        const memory = await mem.recall(input);
        const recallMs = Date.now() - t0;
        const body = { input, instructions: workerInstructions([], {}, memory), session_id: session, ...(effort === "default" ? {} : { model_options: { reasoning_effort: effort } }) };
        const started = await fetch(`${hermesUrl}/v1/runs`, { method: "POST", headers: { Authorization: `Bearer ${hermesKey()}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }).then((r) => r.json());
        const done = await until(async () => { const r = await hermesRun(started.run_id); return r.completed || ["failed", "cancelled"].includes(r.status) ? r : null; }, { timeout: 180000, every: 300 });
        const row = { effort, recallMs, ...runSummary(done), totalMs: Date.now() - t0 };
        out.effort.push(row);
        console.log(JSON.stringify(row));
        await sleep(5000);
      }
      run.extraSessions = sessions;
    });
    out.cleanup = cleanup;
  } else if (check === "3a") {
    const { cleanup } = await testRun("fix3-3a", async (run) => {
      await oneCall(run, async (call) => {
        // 3a's questions and 3d's follow-up are read from the plan's table, so no names live in code.
        const [followUp, lead] = planQuestions("3d");
        for (const q of planQuestions("3a").flatMap((q) => (q === lead ? [q, followUp] : [q]))) {
          await ask(call, q);
          await sleep(2000);
        }
      });
    });
    out.cleanup = cleanup;
    timing(SQL, out.sessions[0]);
  } else if (check === "3b") {
    const { cleanup } = await testRun("fix3-3b", async (run) => {
      const word = await freshWord();
      run.words.push(word);
      out.word = word;
      const toldAt = Date.now();
      console.log(`${new Date(toldAt).toISOString()} hermes -z "Remember this: my garden test word is ${word}."`);
      console.log(`${new Date().toISOString()} ${hermesOneshot(run.name, `Remember this: my garden test word is ${word}.`)}`);
      const waitMs = Number(process.env.FIX3_WAIT_MS || 10 * 60000);
      console.log(`waiting ${waitMs / 60000} minutes`);
      await sleep(Math.max(0, toldAt + waitMs - Date.now()));
      await oneCall(run, async (call) => {
        await ask(call, "What's my garden test word?");
      });
      const q = out.questions[0];
      const said = (q.answer || "").toLowerCase().includes(word);
      out.result = { id: "3b", word, said, pass3c: q.pass };
      console.log(`\n=== 3b ${said ? "PASS" : "FAIL"} word ${JSON.stringify(word)} ${said ? "spoken" : "not spoken"}; answer: ${JSON.stringify(q.answer)}`);
    });
    out.cleanup = cleanup;
    timing(SQL, out.sessions[0]);
  } else throw new Error("Usage: fix3.mjs isolation | sessions <run ids> | 3a | 3b");
} finally {
  out.finished = new Date().toISOString();
  const file = resolve(dir, `fix3-${check}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`\nResults: ${file}`);
}
