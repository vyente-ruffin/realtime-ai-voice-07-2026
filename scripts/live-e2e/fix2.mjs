// Fix 2 live checks (docs/VOICE-FIX-PLAN.md) against the running service and the
// main Hermes gateway. Pass/fail comes from state.sqlite (fragments, jobs, deliveries)
// and the Hermes Runs API. Each check runs separately because some restart Hermes:
//   node scripts/live-e2e/fix2.mjs 2c <word>   ask voice for the test word
//   node scripts/live-e2e/fix2.mjs 2d          voice task needing a tool (run after `hermes update`)
//   node scripts/live-e2e/fix2.mjs 2e          long task, gateway restart mid-run
//   node scripts/live-e2e/fix2.mjs 2f          quick answer while a long task runs
//   node scripts/live-e2e/fix2.mjs 2b          every Fix 2 test job against GET /v1/runs/{id}
//   node scripts/live-e2e/fix2.mjs 2g          /healthz vs Hermes /health, with a 30 s gateway stop
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, turns, base } from "./harness.mjs";
import { TestRun } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { hermesKey } from "../../src/live/worker.js";
import { getLogger } from "../../src/core/logger.js";

const logger = await getLogger("live-e2e.fix2");
const hermes = process.env.HERMES_API_URL || "http://10.69.3.175:8642";
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const ledger = resolve(dir, "fix2-sessions.json");
const check = process.argv[2];
const out = { check, started: new Date().toISOString(), sessions: [], notes: [] };
const FINAL = ["completed", "failed", "cancelled", "interrupted"];

function evidence(id, sql, args, rows, pass, note = "") {
  out.result = { id, sql, args, rows, pass, note };
  logger.info(`check ${id}: ${pass ? "PASS" : "FAIL"}`, { note });
  console.log(`\n=== ${id} ${pass ? "PASS" : "FAIL"} ${note}\nSQL: ${sql}\nARGS: ${JSON.stringify(args)}\nROWS: ${JSON.stringify(rows, null, 1)}`);
}
const stamp = () => new Date().toISOString();
const note = (text) => {
  out.notes.push(`${stamp()} ${text}`);
  console.log(`[${stamp()}] ${text}`);
};
const jobRows = (session, since = 0) =>
  query("SELECT id,session,delegation,state,run_id,hermes_session,created,updated,substr(result,1,300) AS result,error FROM jobs WHERE session=? AND created>=? ORDER BY created", session, since);
const job = (id) => query("SELECT id,state,run_id,hermes_session,created,updated,substr(result,1,300) AS result,error FROM jobs WHERE id=?", id)[0];
const assistantAfter = (session, at) => turns(session).filter((t) => t.role === "assistant" && t.at >= at).map((t) => t.text).join(" ");
async function run(id) {
  const r = await fetch(`${hermes}/v1/runs/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${hermesKey()}` }, signal: AbortSignal.timeout(10000) });
  return { http: r.status, body: r.ok ? await r.json() : await r.text() };
}
async function health() {
  const at = stamp();
  const h = await fetch(`${hermes}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch((e) => ({ error: e.cause?.code || e.message }));
  const v = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  return { at, hermes: h, healthz: { status: v.status, down: v.down, hermes: v.hermes } };
}
const systemctl = (...args) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" });
const activeJobs = () => query("SELECT id,state FROM jobs WHERE state IN ('queued','running','awaiting_permission')");
/** Speak one request and wait for the delegation it causes. */
async function ask(call, text, { job = true, timeout = 45000 } = {}) {
  const file = await speech(text);
  const said = await call.say(file);
  note(`said ${JSON.stringify(text)}`);
  if (!job) return { said };
  const row = await until(() => jobRows(call.session, said.startedAt)[0], { timeout, what: `job for ${JSON.stringify(text)}` });
  note(`job ${row.id} created (${row.state})`);
  return { said, job: row };
}

const testRunState = new TestRun("fix2");
const { browser, context } = ["2b", "2g"].includes(check) ? {} : await launch(testRunState);
let call;
try {
  if (check === "2c") {
    const word = process.argv[3];
    call = await Call.open(context);
    out.sessions.push(await call.start());
    await sleep(5000);
    const question = process.argv[4] || "What's my test word?";
    const asked = await call.say(await speech(question));
    note(`asked: ${question}`);
    // Either answered from context or delegated; wait for any job, then for the spoken answer.
    await until(() => assistantAfter(call.session, asked.startedAt).toLowerCase().includes(word.toLowerCase()), { timeout: 240000, every: 1000, what: "spoken test word" }).catch(() => null);
    await sleep(8000);
    await call.end();
    const sql = "SELECT role,text,at FROM fragments WHERE session=? AND at>=? ORDER BY at,rowid";
    const rows = query(sql, call.session, asked.startedAt);
    const spoken = assistantAfter(call.session, asked.startedAt);
    out.jobs = jobRows(call.session);
    evidence("2c", sql, [call.session, asked.startedAt], { fragments: rows, jobs: out.jobs }, spoken.toLowerCase().includes(word.toLowerCase()),
      `test word ${JSON.stringify(word)}; assistant said: ${JSON.stringify(spoken)}`);
  } else if (check === "2d") {
    call = await Call.open(context);
    out.sessions.push(await call.start());
    await sleep(2000);
    const { said, job: j } = await ask(call, "Please check how much free disk space the root filesystem on this server has right now.");
    const done = await until(() => FINAL.includes(job(j.id)?.state) && job(j.id), { timeout: 300000, every: 1000, what: "tool task" });
    await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND state='injected'", j.id).length, { timeout: 90000, what: "result delivered" }).catch(() => null);
    await sleep(12000);
    await call.end();
    const sql = "SELECT id,state,run_id,created,updated,substr(result,1,300) AS result,error FROM jobs WHERE session=? AND created>=?";
    const rows = query(sql, call.session, said.startedAt);
    out.status = await run(done.run_id);
    out.transcript = turns(call.session);
    evidence("2d", sql, [call.session, said.startedAt], { jobs: rows, hermesRun: out.status, spoken: assistantAfter(call.session, said.startedAt) },
      rows.length === 1 && rows[0].state === "completed" && out.status.body?.status === "completed",
      `jobs created=${rows.length}; state=${rows[0]?.state}`);
  } else if (check === "2e") {
    call = await Call.open(context);
    out.sessions.push(await call.start());
    await sleep(2000);
    const { job: j } = await ask(call, "Please start a background task: on this server, wait four minutes using the sleep command, then tell me it finished.");
    await until(() => job(j.id)?.run_id && job(j.id).state === "running" && job(j.id), { timeout: 60000, what: "run id" });
    await sleep(15000);
    note(`job ${j.id} running as ${job(j.id).run_id}; restarting hermes-gateway.service`);
    const restartAt = Date.now();
    systemctl("restart", "hermes-gateway.service");
    note("restart command returned");
    const settled = await until(() => job(j.id).state !== "running" && job(j.id), { timeout: 120000, every: 500, what: "job settles" }).catch(() => job(j.id));
    out.settleSeconds = (settled.updated - restartAt) / 1000;
    note(`job state ${settled.state} after ${out.settleSeconds}s`);
    await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND state='injected'", j.id).length, { timeout: 90000, what: "interruption spoken" }).catch(() => null);
    await sleep(15000);
    const first = call.session;
    await call.end();
    await call.page.close();
    // Reconnect later as a new call: the interruption must never come back as a fresh result.
    call = await Call.open(context);
    out.sessions.push(await call.start());
    await sleep(45000);
    await call.end();
    const sql = "SELECT j.id,j.state,j.run_id,j.updated,j.error,j.result,d.state AS delivery,d.session AS delivered_in,d.updated AS delivered_at FROM jobs j LEFT JOIN deliveries d ON d.job=j.id WHERE j.id=?";
    const rows = query(sql, j.id);
    const spoken = turns(first).filter((t) => t.role === "assistant" && t.at >= restartAt);
    const later = query("SELECT job,state,session,updated FROM deliveries WHERE session=?", call.session);
    const laterSpoken = turns(call.session).filter((t) => t.role === "assistant");
    out.hermesRun = await run(settled.run_id);
    const mentions = spoken.filter((t) => /restart|interrupt|stopp?ed|didn'?t finish|did not finish/i.test(t.text));
    evidence("2e", sql, [j.id], { job: rows, hermesRun: out.hermesRun, assistantAfterRestart: spoken, laterCallDeliveries: later, laterCallAssistant: laterSpoken },
      settled.state === "interrupted" && out.settleSeconds <= 60 && rows[0].delivery === "injected" && rows[0].delivered_in === first &&
        mentions.length === 1 && later.length === 0 && !laterSpoken.some((t) => /restart|interrupt|sleep/i.test(t.text)),
      `settled ${settled.state} in ${out.settleSeconds}s; assistant turns mentioning it=${mentions.length}; later-call deliveries=${later.length}`);
  } else if (check === "2f") {
    call = await Call.open(context);
    out.sessions.push(await call.start());
    await sleep(2000);
    const { job: long } = await ask(call, "Please start a background task: on this server, wait three minutes using the sleep command, then tell me it finished.");
    await until(() => job(long.id)?.run_id && job(long.id), { timeout: 60000, what: "long run id" });
    await sleep(10000);
    const { job: quick } = await ask(call, "Also, check how long this server has been up.");
    const quickDone = await until(() => FINAL.includes(job(quick.id)?.state) && job(quick.id), { timeout: 240000, every: 500, what: "quick job" });
    const longAtQuick = job(long.id);
    note(`quick ${quickDone.state} after ${(quickDone.updated - quickDone.created) / 1000}s; long state then ${longAtQuick.state}`);
    await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND state='injected'", quick.id).length, { timeout: 90000, what: "quick result spoken" }).catch(() => null);
    const longDone = await until(() => FINAL.includes(job(long.id)?.state) && job(long.id), { timeout: 300000, every: 1000, what: "long job" });
    await sleep(20000);
    await call.end();
    const sql = "SELECT id,state,run_id,hermes_session,created,updated,substr(result,1,200) AS result FROM jobs WHERE id IN (?,?)";
    const rows = query(sql, long.id, quick.id);
    out.transcript = turns(call.session);
    evidence("2f", sql, [long.id, quick.id], { jobs: rows, longStateWhenQuickFinished: longAtQuick.state },
      quickDone.state === "completed" && longAtQuick.state === "running" && quickDone.updated < longDone.updated && longDone.updated - long.created > 120000,
      `quick took ${(quickDone.updated - quickDone.created) / 1000}s; long was ${longAtQuick.state} when quick completed; long finished ${(longDone.updated - quickDone.updated) / 1000}s later`);
  } else if (check === "2b") {
    const sessions = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : [];
    const marks = sessions.map(() => "?").join(",");
    const sql = `SELECT id,session,state,run_id,hermes_session FROM jobs WHERE session IN (${marks}) ORDER BY created`;
    const rows = query(sql, ...sessions);
    const results = [];
    for (const r of rows) {
      const status = r.run_id ? await run(r.run_id) : null;
      const s = status?.body?.status;
      const matches = Boolean(r.run_id) && (s === r.state || (r.state === "running" && ["queued", "running", "waiting_for_approval"].includes(s)));
      results.push({ job: r.id, state: r.state, run_id: r.run_id, hermes_session: r.hermes_session, http: status?.http, hermes_status: s, hermes_session_id: status?.body?.session_id, matches });
    }
    out.runs = results;
    evidence("2b", sql + "  -- then GET /v1/runs/{run_id} for each", sessions, results, results.length > 0 && results.every((x) => x.matches),
      `${results.filter((x) => x.matches).length}/${results.length} jobs have a run id with matching Hermes status`);
  } else if (check === "2g") {
    if (activeJobs().length) throw new Error("Jobs are active; not stopping the gateway.");
    const samples = [await health(), await health()];
    note("stopping hermes-gateway.service for 30 s");
    const stopAt = Date.now();
    systemctl("stop", "hermes-gateway.service");
    while (Date.now() - stopAt < 30000) {
      samples.push(await health());
      await sleep(5000);
    }
    systemctl("start", "hermes-gateway.service");
    note("started hermes-gateway.service");
    for (let i = 0; i < 40; i++) {
      const s = await health();
      samples.push(s);
      if (s.hermes.status === "ok" && s.healthz.status === "ready") break;
      await sleep(3000);
    }
    samples.push(await health());
    const agree = samples.map((s) => ({ ...s, consistent: (s.healthz.status === "ready") === (s.hermes.status === "ok") }));
    out.samples = agree;
    evidence("2g", "GET /healthz and GET <hermes>/health side by side", [hermes, base], agree,
      agree.every((s) => s.consistent) && agree.some((s) => s.healthz.status === "degraded" && s.healthz.down?.includes("hermes")),
      `${agree.filter((s) => s.consistent).length}/${agree.length} samples agree; degraded samples naming hermes=${agree.filter((s) => s.healthz.down?.includes("hermes")).length}`);
  } else throw new Error("Usage: fix2.mjs 2b|2c|2d|2e|2f|2g");
} finally {
  out.finished = stamp();
  if (out.sessions.length) {
    const all = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : [];
    writeFileSync(ledger, JSON.stringify([...new Set([...all, ...out.sessions])]), { mode: 0o600 });
  }
  const file = resolve(dir, `fix2-${check}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`\nResults: ${file}`);
  await browser?.close();
  await testRunState.finish();
}
