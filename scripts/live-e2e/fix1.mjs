// Fix 1 live checks 1a-1f (docs/VOICE-FIX-PLAN.md) against the running service.
// Every pass/fail is measured from state.sqlite (fragments, jobs, deliveries).
// Usage: node scripts/live-e2e/fix1.mjs   (about 12 minutes; real Azure + Hermes calls)
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, turns } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { getLogger } from "../../src/core/logger.js";

const logger = await getLogger("live-e2e.fix1");
const FINAL = "('completed','failed','cancelled','interrupted')";
const out = { started: new Date().toISOString(), sessions: {}, checks: {} };
const evidence = (id, sql, args, rows, pass, note = "") => {
  out.checks[id] = { ...(out.checks[id] || {}), sql, args, rows, pass, note };
  logger.info(`check ${id}: ${pass ? "PASS" : "FAIL"}`, { note });
  console.log(`\n=== ${id} ${pass ? "PASS" : "FAIL"} ${note}\nSQL: ${sql}\nARGS: ${JSON.stringify(args)}\nROWS: ${JSON.stringify(rows, null, 1)}`);
};
// The voice model must not be able to answer from the request text: Hermes picks the key word.
const task = (choice, sentences) =>
  `Automated voice test for Hermes. Choose ${choice} yourself, then reply with exactly these sentences and nothing else, without using any tools: ${sentences}`;
const key = (id) => (query("SELECT result FROM jobs WHERE id=?", id)[0]?.result || "").match(/ is ([^.]+)\./)?.[1]?.trim() || "\u0000";
const jobRow = (id) => query("SELECT id,session,state,updated FROM jobs WHERE id=?", id)[0];
const waitFinal = (id, timeout = 300000) =>
  until(() => ["completed", "failed", "cancelled", "interrupted"].includes(jobRow(id)?.state) && jobRow(id), { timeout, every: 1000, what: `job ${id}` });

const audio = {
  yes: await speech("Yes, tell me."),
  stop: await speech("Stop."),
  question: await speech("What's the capital of France?"),
  count: await speech(
    "This is an automated voice test and I am counting slowly, one, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty, twenty one, twenty two, twenty three, twenty four, twenty five, twenty six, twenty seven, twenty eight, twenty nine, thirty",
    { continuous: true },
  ),
};
const { browser, context } = await launch();
try {
  // ---- Call 1: start a job, end the call before its result can be delivered.
  let call = await Call.open(context);
  const s1 = (out.sessions.call1 = await call.start());
  await sleep(2000);
  const jobA = await call.type(task("one random uncommon bird species", "The test bird is <the species>. It was seen at the east pond."));
  out.jobA = jobA.id;
  await call.end();
  const call1End = Date.now();
  await call.page.close();
  const a = await waitFinal(jobA.id);
  logger.info("job A finished", { state: a.state });
  const resume = Math.max(call1End, Date.now()) + 5 * 60000;
  logger.info("waiting 5 minutes before the next call", { until: new Date(resume).toISOString() });
  await sleep(resume - Date.now());

  // ---- Call 2 (1a, 1b): silent 60 s, then "yes, tell me".
  call = await Call.open(context);
  const s2 = (out.sessions.call2 = await call.start());
  const call2Start = Date.now();
  await sleep(60000);
  {
    const sql = `SELECT d.job,d.state,d.session,d.updated,j.session AS job_session FROM deliveries d JOIN jobs j ON j.id=d.job WHERE d.session=? AND j.session<>?`;
    const rows = query(sql, s2, s2);
    const assistant = turns(s2).filter((t) => t.role === "assistant");
    const waitingLines = assistant.filter((t) => /finished while you were away|while you were away|want (it|them)/i.test(t.text));
    out.checks["1a"] = { transcript: turns(s2) };
    evidence("1a", sql, [s2, s2], rows, rows.length === 0 && assistant.length === 1 && waitingLines.length === 1,
      `deliveries for earlier-call jobs=${rows.length}; assistant turns in first 60 s=${assistant.length}; waiting lines=${waitingLines.length}`);
  }
  const yes = await call.say(audio.yes);
  out.yes = yes;
  await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND session=? AND state='injected'", jobA.id, s2).length, { timeout: 150000, what: "1b delivery" }).catch(() => null);
  await sleep(12000);
  {
    const sql = `SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments f WHERE f.session=? AND f.role='user' AND f.at>=?) AS yes_fragment_at FROM deliveries d WHERE d.job=?`;
    const rows = query(sql, s2, call2Start, jobA.id);
    const r = rows[0];
    const spoken = turns(s2).filter((t) => t.role === "assistant" && r && t.at > r.yes_fragment_at).map((t) => t.text).join(" ");
    out.checks["1b"] = { transcript: turns(s2) };
    evidence("1b", sql, [s2, call2Start, jobA.id], rows,
      Boolean(r && r.state === "injected" && r.session === s2 && r.updated > r.yes_fragment_at && spoken.toLowerCase().includes(key(jobA.id).toLowerCase())),
      `job A key word ${JSON.stringify(key(jobA.id))}; assistant after yes: ${JSON.stringify(spoken)}`);
  }
  await call.end();
  await call.page.close();

  // ---- Call 3 (1c, 1d): two results from this call waiting; "stop" while the first is read.
  call = await Call.open(context);
  const s3 = (out.sessions.call3 = await call.start());
  await sleep(2000);
  const jobB = await call.type(task("one random gemstone", "The lantern stone is <the gemstone>. The lantern is painted green and hangs beside the north door. It was checked this morning and works well."));
  const jobC = await call.type(task("one random river in South America", "The test river is <the river>. Its gauge sits under an old stone bridge. It was read at noon today."));
  out.jobB = jobB.id;
  out.jobC = jobC.id;
  // Keep talking (one unbroken turn) so neither result can be pushed until both are waiting.
  await call.say(audio.count, { loop: true });
  await waitFinal(jobB.id);
  await waitFinal(jobC.id);
  await call.hush();
  const firstOffer = await until(async () => (await call.events("result.offered")).at(0), { timeout: 90000, every: 100, what: "first result offered" });
  await until(async () => (await call.events("session.output_transcript.delta")).some((e) => e.ts > firstOffer.ts), { timeout: 30000, every: 50, what: "first result being read" });
  await sleep(700);
  const stop = await call.say(audio.stop);
  out.stop = { ...stop, job: firstOffer.job };
  await sleep(31000);
  {
    const stopFrag = await until(() => query("SELECT MIN(at) AS at,MIN(start_ms) AS start_ms FROM fragments WHERE session=? AND role='user' AND at>=? AND text LIKE '%top%'", s3, stop.startedAt)[0]?.at && query("SELECT MIN(at) AS at,MIN(start_ms) AS start_ms FROM fragments WHERE session=? AND role='user' AND at>=? AND text LIKE '%top%'", s3, stop.startedAt)[0], { timeout: 5000, what: "stop fragment" });
    const from = stopFrag.at, to = stopFrag.at + 30000;
    // Corrected 1c rule (plan, Oct 9): words already playing may finish within 1 s of the
    // stop fragment; no assistant fragment may START later than that (session audio clock).
    // All assistant fragments received in the 30 s are listed too, for transparency.
    const sqlA = "SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND start_ms>?+1000 AND start_ms<=?+31000";
    const sqlAll = "SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<=?";
    const sqlD = "SELECT job,state,session,updated FROM deliveries WHERE session=? AND updated>? AND updated<=?";
    const sqlW = `SELECT id,state,updated FROM jobs WHERE id IN (?,?)`;
    const assistant = query(sqlA, s3, stopFrag.start_ms, stopFrag.start_ms);
    const received = query(sqlAll, s3, from, to);
    const deliveries = query(sqlD, s3, from, to);
    const waiting = query(sqlW, jobB.id, jobC.id);
    const second = waiting.find((j) => j.id !== firstOffer.job);
    const secondWasWaiting = second && second.updated < from && !query("SELECT 1 FROM deliveries WHERE job=? AND updated<=?", second.id, to).length;
    out.checks["1c"] = { stopFragment: stopFrag, waitingJobs: waiting, transcript: turns(s3) };
    evidence("1c", `${sqlA};\n${sqlAll};\n${sqlD};\n${sqlW}`, [s3, stopFrag.start_ms, from, to, jobB.id, jobC.id], { assistant, received, deliveries, waiting },
      assistant.length === 0 && deliveries.length === 0 && Boolean(secondWasWaiting),
      `stop fragment start_ms=${stopFrag.start_ms}; assistant fragments starting >1 s after stop=${assistant.length} (received in 30 s, incl. tail=${received.length}); new deliveries in 30 s=${deliveries.length}; second result final and waiting=${Boolean(secondWasWaiting)}`);
  }
  const asked = await call.say(audio.question);
  out.question = asked;
  const second = firstOffer.job === jobB.id ? jobC.id : jobB.id;
  await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND session=?", second, s3).length, { timeout: 90000, what: "1d resumed delivery" }).catch(() => null);
  await sleep(15000);
  {
    const q = query("SELECT MIN(at) AS at FROM fragments WHERE session=? AND role='user' AND at>=?", s3, asked.startedAt)[0].at;
    const sql = "SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments WHERE session=? AND role='assistant' AND at>?) AS answer_at,(SELECT group_concat(text,'') FROM (SELECT text FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<d.updated ORDER BY at,rowid)) AS answer_text FROM deliveries d WHERE d.job=?";
    const rows = query(sql, s3, q, s3, q, second);
    const r = rows[0];
    out.checks["1d"] = { questionFragmentAt: q, transcript: turns(s3) };
    evidence("1d", sql, [s3, q, s3, q, second], rows,
      Boolean(r && r.session === s3 && r.answer_at && r.updated > r.answer_at && /paris/i.test(r.answer_text || "")),
      `question fragment at ${q}`);
  }
  await call.end();
  await call.page.close();

  // ---- 1e: backlog closed.
  {
    const cutoff = Date.parse("2026-10-09T00:00:00-07:00");
    const sql = `SELECT COUNT(*) AS n FROM jobs j LEFT JOIN deliveries d ON d.job=j.id WHERE j.state IN ${FINAL} AND j.updated<? AND (d.state IS NULL OR d.state='available')`;
    const rows = query(sql, cutoff);
    evidence("1e", sql, [cutoff], rows, rows[0].n === 0);
  }
  // ---- 1f: no delivery within 10 s of user speech that overlapped assistant speech.
  {
    const sessions = Object.values(out.sessions);
    const marks = sessions.map(() => "?").join(",");
    const sql = `SELECT u.session,u.text,u.at,u.start_ms,u.end_ms,d.job,d.state,d.updated FROM fragments u JOIN deliveries d ON d.session=u.session AND d.updated>=u.at AND d.updated<u.at+10000 WHERE u.role='user' AND u.session IN (${marks}) AND EXISTS (SELECT 1 FROM fragments a WHERE a.session=u.session AND a.role='assistant' AND a.start_ms<u.end_ms AND a.end_ms>u.start_ms)`;
    const rows = query(sql, ...sessions);
    const overlaps = query(`SELECT u.session,u.text,u.at,u.start_ms,u.end_ms FROM fragments u WHERE u.role='user' AND u.session IN (${marks}) AND EXISTS (SELECT 1 FROM fragments a WHERE a.session=u.session AND a.role='assistant' AND a.start_ms<u.end_ms AND a.end_ms>u.start_ms)`, ...sessions);
    out.checks["1f"] = { overlappingUserFragments: overlaps };
    evidence("1f", sql, sessions, rows, rows.length === 0, `overlapping user fragments=${overlaps.length}`);
  }
} finally {
  out.finished = new Date().toISOString();
  const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, `fix1-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`\nResults: ${file}`);
  await browser.close();
}
