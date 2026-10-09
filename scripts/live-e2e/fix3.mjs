// Fix 3 live checks (docs/VOICE-FIX-PLAN.md): answers about the user come from real
// memory, quickly, in context. Pass/fail timing comes from state.sqlite fragments;
// each spoken answer is printed next to a Hindsight recall on bank `hermes` for the
// same question, so the facts can be compared. No facts about the user live here:
// questions come from the plan or the command line.
//   node scripts/live-e2e/fix3.mjs 3a          the four 3a questions plus the 3d follow-up, one call
//   node scripts/live-e2e/fix3.mjs 3d          3d's lead question then its follow-up, one call
//   node scripts/live-e2e/fix3.mjs 3b <word> "<question>"   ask for a fact told to the main profile earlier
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, turns } from "./harness.mjs";
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
  const answer = injected ? assistantTurns.find((t) => t.lastAt >= injected.delivered) : assistantTurns.find((t) => !PREFACE.test(t.text));
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

const { browser, context } = await launch();
let call;
try {
  call = await Call.open(context);
  out.sessions.push(await call.start());
  console.log(`session ${call.session}`);
  await sleep(4000);
  // 3a's questions and 3d's follow-up are read from the plan's table, so no names live in code.
  const ask3a = planQuestions("3a");
  const [followUp, lead] = planQuestions("3d");
  const questions = check === "3a"
    ? ask3a.flatMap((q) => (q === lead ? [q, followUp] : [q]))
    : check === "3d" ? [lead, followUp]
    : check === "3b" ? [process.argv[4] || "What's my memory check word?"] : null;
  if (!questions) throw new Error("Usage: fix3.mjs 3a | 3d | 3b <word> [question]");
  for (const q of questions) {
    await ask(call, q);
    await sleep(2000);
  }
  await call.end();
  const sql = "SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid";
  out.transcript = turns(call.session);
  out.jobs = query("SELECT id,state,run_id,created,updated FROM jobs WHERE session=?", call.session);
  if (check === "3b") {
    const word = process.argv[3].toLowerCase();
    const q = out.questions[0];
    const said = (q.answer || "").toLowerCase().includes(word);
    out.result = { id: "3b", word, said, pass3c: q.pass };
    console.log(`\n=== 3b ${said ? "PASS" : "FAIL"} word ${JSON.stringify(word)} ${said ? "spoken" : "not spoken"}; answer: ${JSON.stringify(q.answer)}`);
  }
  const times = out.questions.map((q) => ({ question: q.question, latencyMs: q.latencyMs, audioClockLatencyMs: q.audioClockLatencyMs, pass: q.pass }));
  console.log(`\n=== 3c ${times.every((t) => t.pass) ? "PASS" : "FAIL"} (limit ${LIMIT_MS} ms)\nSQL: ${sql}\nARGS: ${JSON.stringify([call.session])}\n${JSON.stringify(times, null, 1)}`);
  console.log(`\nTRANSCRIPT:\n${out.transcript.map((t) => `${new Date(t.at).toISOString()} ${t.role}: ${t.text}`).join("\n")}\nJOBS: ${JSON.stringify(out.jobs)}`);
} finally {
  out.finished = new Date().toISOString();
  const file = resolve(dir, `fix3-${check}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`\nResults: ${file}`);
  await browser?.close();
}
