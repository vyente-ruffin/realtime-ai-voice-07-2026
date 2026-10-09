// Fix 4 live checks (docs/VOICE-FIX-PLAN.md): honest status. Every run is a TestRun (its own
// test conversation, never the owner's; cleanup.mjs always runs). Pass/fail comes from
// state.sqlite: each status question is printed with the `jobs` row read at the moment the
// question ended, the assistant fragments that answered it, and the quiet status context the
// page sent the voice model.
//   node scripts/live-e2e/fix4.mjs 4ab       a >2 min task; "how's it going?" at ~30 s and ~90 s, "what are you doing on that?" after its first tool step
//   node scripts/live-e2e/fix4.mjs cancel    stop the task's run with POST /v1/runs/{id}/stop, then ask about it
//   node scripts/live-e2e/fix4.mjs restart   restart hermes-gateway.service during the task, then ask about it
//   node scripts/live-e2e/fix4.mjs 4d        no running jobs anywhere; "is anything running?"
//   node scripts/live-e2e/fix4.mjs 4e <conversation ids>   banned phrases in every assistant fragment of those test conversations
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { launch, Call, sleep, until, query, turns, testRun } from "./harness.mjs";
import { hermesKey } from "../../src/live/worker.js";
import { speech } from "./tts.mjs";
import { getLogger } from "../../src/core/logger.js";

const logger = await getLogger("live-e2e.fix4");
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const check = process.argv[2];
const out = { check, started: new Date().toISOString(), questions: [] };
const hermesUrl = process.env.HERMES_API_URL || "http://10.69.3.175:8642";
const BANNED = /nothing solid yet|internal glitch|the system ran into/i;
// A task that runs over two minutes and has one clear first tool step.
const LONG_TASK = "Please use the terminal to run the command sleep 150, and tell me when it finishes.";
const TASK_WORDS = /sleep|command|terminal|timer|wait|150/i;

const JOB_SQL = "SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created";
const jobs = (conversation) => query(JOB_SQL, conversation);
// By conversation, not session: a reconnect mid-call starts a new provider session.
const FRAG_SQL = "SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE conversation=? AND at>=? ORDER BY at,rowid";
const runningRows = () => query("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','awaiting_permission')")[0].n;

async function hermes(path, { method = "GET", body } = {}) {
  try {
    const r = await fetch(hermesUrl + path, {
      method,
      headers: { Authorization: `Bearer ${hermesKey()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (err) {
    return { status: null, body: { unreachable: err.cause?.code || err.message } };
  }
}

/** The run's own event stream as Hermes sent it: read the backlog for a few seconds, then let go. */
async function hermesEvents(run, ms = 3000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  let text = "";
  try {
    const r = await fetch(`${hermesUrl}/v1/runs/${encodeURIComponent(run)}/events?last_seq=-1`, { headers: { Authorization: `Bearer ${hermesKey()}` }, signal: abort.signal });
    for await (const chunk of r.body) text += Buffer.from(chunk).toString("utf8");
  } catch {} finally {
    clearTimeout(timer);
  }
  const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  return events.filter((e) => ["tool.started", "tool.completed", "message.interim", "run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(e.event))
    .map((e) => ({ seq: e.seq, event: e.event, tool: e.tool, preview: e.preview, text: e.text, error: e.error, timestamp: e.timestamp && new Date(e.timestamp * 1000).toISOString() }));
}

/** Speak, then wait for the reply to finish (6 s of assistant quiet). Jobs are read when the question ends. */
async function ask(call, conversation, text, { quietMs = 6000, timeout = 45000 } = {}) {
  const said = await call.say(await speech(text));
  const rowsAtQuestionEnd = jobs(conversation);
  const contextAtQuestionEnd = (await call.events("status.context")).at(-1)?.text ?? null;
  await until(() => {
    const a = query(FRAG_SQL, conversation, said.startedAt).filter((r) => r.role === "assistant");
    return a.length && Date.now() - a.at(-1).at > quietMs;
  }, { timeout, what: `reply to ${JSON.stringify(text)}` }).catch(() => null);
  const fragments = query(FRAG_SQL, conversation, said.startedAt);
  const answer = fragments.filter((r) => r.role === "assistant").map((r) => r.text).join("").trim();
  const heard = fragments.filter((r) => r.role === "user").map((r) => r.text).join("").trim();
  const entry = {
    question: text, heard, saidEndedAt: new Date(said.endedAt).toISOString(), answer,
    rowsAtQuestionEnd, rowsAfterAnswer: jobs(conversation), contextAtQuestionEnd,
  };
  out.questions.push(entry);
  logger.info("status question", { question: text, answer });
  console.log(`\n--- Q (${entry.saidEndedAt}): ${text}\nUSER (transcribed): ${heard}\nJOBS ROW AT QUESTION END (${JOB_SQL}):\n${JSON.stringify(rowsAtQuestionEnd, null, 1)}\nQUIET STATUS CONTEXT LAST SENT:\n${contextAtQuestionEnd}\nASSISTANT: ${answer}`);
  return entry;
}

async function oneCall(run, body) {
  const { browser, context } = await launch(run);
  try {
    const call = await Call.open(context);
    await call.start();
    out.conversation = run.conversation;
    out.session = call.session;
    console.log(`test run ${run.name}, test conversation ${run.conversation}, session ${call.session}`);
    await sleep(4000);
    await body(call, run.conversation);
    await call.end();
    const sessions = query("SELECT DISTINCT session FROM fragments WHERE conversation=? ORDER BY at", run.conversation).map((r) => r.session);
    out.transcript = sessions.flatMap((s) => turns(s).map((t) => ({ session: s, ...t }))).sort((a, b) => a.at - b.at);
    out.appErrors = (await call.events("app.error")).map((e) => ({ at: new Date(e.ts).toISOString(), message: e.message }));
    if (out.appErrors.length) console.log(`PAGE ERRORS: ${JSON.stringify(out.appErrors)}`);
    out.jobs = jobs(run.conversation);
    out.statusContexts = (await call.events("status.context")).map((e) => ({ at: new Date(e.ts).toISOString(), text: e.text }));
    console.log(`\nTRANSCRIPT (fragments joined per speaker):\n${out.transcript.map((t) => `${new Date(t.at).toISOString()} [${t.session}] ${t.role}: ${t.text}`).join("\n")}\nJOBS: ${JSON.stringify(out.jobs, null, 1)}`);
  } finally {
    await browser.close();
  }
}

/** Ask for the long task and wait until its Hermes run has reported a first step. */
async function startLongTask(call, conversation) {
  await ask(call, conversation, LONG_TASK, { quietMs: 4000 });
  const job = await until(() => jobs(conversation).find((j) => j.run_id && j.state === "running"), { timeout: 60000, what: "running job" });
  const stepped = await until(() => jobs(conversation).find((j) => j.id === job.id && j.progress), { timeout: 90000, what: "first progress step" });
  console.log(`JOB STARTED ${new Date(job.created).toISOString()} run ${job.run_id}; first step at ${new Date(stepped.progress_at).toISOString()}: ${stepped.progress}`);
  return stepped;
}
const waitUntil = (at) => sleep(Math.max(0, at - Date.now()));

try {
  if (check === "4ab") {
    out.cleanup = (await testRun("fix4-4ab", (run) => oneCall(run, async (call, conversation) => {
      const job = await startLongTask(call, conversation);
      await waitUntil(job.created + 30000);
      const q30 = await ask(call, conversation, "How's it going?");
      const q4b = await ask(call, conversation, "What are you doing on that?");
      const events = await hermesEvents(job.run_id);
      out.hermesEventsAt4b = events;
      console.log(`HERMES EVENTS (GET ${hermesUrl}/v1/runs/${job.run_id}/events?last_seq=-1, progress kinds only) after the 4b question:\n${JSON.stringify(events, null, 1)}`);
      await waitUntil(job.created + 90000);
      const q90 = await ask(call, conversation, "How's it going?");
      // Let it finish so the run ends cleanly inside the test conversation.
      await until(() => !["queued", "running", "awaiting_permission"].includes(jobs(conversation).find((j) => j.id === job.id).state), { timeout: 240000, what: "task end" });
      await sleep(20000);
      out.result = { q30: q30.answer, q4b: q4b.answer, q90: q90.answer };
    }))).cleanup;
  } else if (check === "cancel" || check === "restart") {
    out.cleanup = (await testRun(`fix4-${check}`, (run) => oneCall(run, async (call, conversation) => {
      const job = await startLongTask(call, conversation);
      if (check === "cancel") {
        const stop = await hermes(`/v1/runs/${encodeURIComponent(job.run_id)}/stop`, { method: "POST", body: {} });
        console.log(`\n${new Date().toISOString()} POST ${hermesUrl}/v1/runs/${job.run_id}/stop -> HTTP ${stop.status} ${JSON.stringify(stop.body)}`);
      } else {
        const t0 = Date.now();
        execFileSync("systemctl", ["--user", "restart", "hermes-gateway.service"], { timeout: 180000 });
        console.log(`\n${new Date(t0).toISOString()} systemctl --user restart hermes-gateway.service -> done in ${Date.now() - t0} ms`);
        console.log(execFileSync("systemctl", ["--user", "is-active", "hermes-gateway.service"], { encoding: "utf8" }).trim());
        await until(async () => (await hermes("/health")).body?.status === "ok", { timeout: 240000, every: 2000, what: "Hermes back" });
        console.log(`${new Date().toISOString()} Hermes /health ok again (${Date.now() - t0} ms after the restart began)`);
      }
      const ended = await until(() => {
        const j = jobs(conversation).find((x) => x.id === job.id);
        return !["queued", "running", "awaiting_permission"].includes(j.state) && j;
      }, { timeout: 240000, what: "job settled" });
      const run_ = await hermes(`/v1/runs/${encodeURIComponent(job.run_id)}`);
      if (check === "cancel") console.log(`HERMES EVENTS: ${JSON.stringify(await hermesEvents(job.run_id, 2000), null, 1)}`);
      console.log(`JOB SETTLED ${new Date(ended.updated).toISOString()}: ${JSON.stringify(ended)}\nHERMES RUN: ${JSON.stringify({ status: run_.body?.status, error: run_.body?.error })}`);
      // The app speaks this call's ended task once on its own (Fix 1); let that finish first.
      await sleep(15000);
      const q = await ask(call, conversation, "What happened with that task?");
      out.result = { answer: q.answer, state: ended.state, error: ended.error };
    }))).cleanup;
  } else if (check === "4d") {
    out.cleanup = (await testRun("fix4-4d", (run) => oneCall(run, async (call, conversation) => {
      await sleep(3000);
      const before = runningRows();
      const q = await ask(call, conversation, "Is anything running?");
      const after = runningRows();
      console.log(`\nSELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','awaiting_permission') -> at question end ${before}, after answer ${after}`);
      out.result = { answer: q.answer, runningAtQuestion: before, runningAfter: after, newJobs: jobs(conversation).length };
    }))).cleanup;
  } else if (check === "4e") {
    const ids = process.argv.slice(3);
    const sql = `SELECT f.session,f.at,f.text FROM fragments f WHERE f.role='assistant' AND f.conversation IN (${ids.map(() => "?").join(",")}) ORDER BY f.at,f.rowid`;
    const rows = query(sql, ...ids);
    const bySession = {};
    for (const r of rows) (bySession[r.session] ||= []).push(r.text);
    const hits = Object.entries(bySession).filter(([, t]) => BANNED.test(t.join("")));
    console.log(`SQL: ${sql}\nARGS: ${JSON.stringify(ids)}\nassistant fragments: ${rows.length} in ${Object.keys(bySession).length} sessions\nbanned pattern: ${BANNED}\nsessions with hits: ${hits.length}${hits.map(([s, t]) => `\n${s}: ${t.join("")}`).join("")}`);
    out.result = { fragments: rows.length, hits: hits.length };
  } else throw new Error("Usage: fix4.mjs 4ab | cancel | restart | 4d | 4e <conversation ids>");
} finally {
  out.finished = new Date().toISOString();
  const file = resolve(dir, `fix4-${check}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`\nResults: ${file}`);
}
