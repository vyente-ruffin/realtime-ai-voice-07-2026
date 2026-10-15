// Fix 5 live checks (docs/VOICE-FIX-PLAN.md): let V finish talking. Every call is its own
// TestRun (its own test conversation, never the owner's; cleanup.mjs always runs). Pass/fail
// comes from state.sqlite `fragments` and `jobs`, on the session audio clock (start_ms/end_ms).
//   node scripts/live-e2e/fix5.mjs 5abc [runs=5]   "So can you check... uh..." + 1.5 s silence + "what time it is in Tokyo."
//   node scripts/live-e2e/fix5.mjs 5d              rerun of Fix 1 check 1c (silence after stop)
//   node scripts/live-e2e/fix5.mjs judge <conversation>...   re-measure earlier 5a-5c runs from state.sqlite
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, turns, testRun } from "./harness.mjs";
import { speech, splice } from "./tts.mjs";
import { judge } from "./fix5-judge.mjs";
import { getLogger } from "../../src/core/logger.js";

const logger = await getLogger("live-e2e.fix5");
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const check = process.argv[2];
const out = { check, started: new Date().toISOString(), build: await (await fetch("http://127.0.0.1:8787/healthz")).json().then((h) => h.buildId), runs: [] };
const FRAG_SQL = "SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE conversation=? ORDER BY at,rowid";
const JOB_SQL = "SELECT id,state,title,created,updated FROM jobs WHERE conversation=? ORDER BY created";
const save = () => {
  const file = resolve(dir, `fix5-${check}-${Date.parse(out.started)}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  return file;
};

async function pauseRun(i, wav) {
  return testRun(`fix5-5abc-${i}`, async (run) => {
    const conversation = await run.conversationId();
    const { browser, context } = await launch(run);
    try {
      // A provider connection failure is not a measured run: record it, wait a minute, call again.
      let call, session;
      for (let attempt = 1; ; attempt++) {
        call = await Call.open(context);
        try {
          session = await call.start();
          break;
        } catch (err) {
          if (!err.connect || attempt === 3) throw err;
          out.connectFailures = [...(out.connectFailures || []), { run: run.name, attempt, at: new Date().toISOString(), error: err.message }];
          console.log(`[connect] ${run.name} attempt ${attempt} failed: ${err.message}; retrying in 60 s`);
          await call.page.close();
          await sleep(60000);
        }
      }
      await sleep(3000);
      const said = await call.say(wav.file);
      await sleep(15000);
      await call.end();
      const frags = query(FRAG_SQL, conversation);
      const jobs = query(JOB_SQL, conversation);
      const verdict = judge(frags, jobs, wav.offsets);
      const r = { run: run.name, conversation, session, said, wavOffsets: wav.offsets, frags, jobRows: jobs, verdict };
      out.runs.push(r);
      console.log(`\n=== run ${i} ${run.name} conversation=${conversation} session=${session}`);
      console.log(`SQL: ${FRAG_SQL}   ARGS: ["${conversation}"]`);
      for (const f of frags) console.log(`  ${f.role.padEnd(9)} start_ms=${String(f.start_ms).padStart(6)} end_ms=${String(f.end_ms).padStart(6)} at=${f.at} ${JSON.stringify(f.text)}`);
      console.log(`SQL: ${JOB_SQL}   ARGS: ["${conversation}"]\n  ${JSON.stringify(jobs)}`);
      console.log(`VERDICT ${JSON.stringify({ ...verdict, assistantInPause: verdict.assistantInPause.map((f) => [f.start_ms, f.text]) })}`);
      return r;
    } finally {
      await browser.close();
    }
  });
}

// Fix 1 check 1c, as in scripts/live-e2e/fix1.mjs call 3: two results from this call
// waiting; "stop" while the first is being read; 30 s of silence.
const task = (choice, sentences) =>
  `Automated voice test for Hermes. Choose ${choice} yourself, then reply with exactly these sentences and nothing else, without using any tools: ${sentences}`;
const jobRow = (id) => query("SELECT id,session,state,updated FROM jobs WHERE id=?", id)[0];
const waitFinal = (id, timeout = 300000) =>
  until(() => ["completed", "failed", "cancelled", "interrupted"].includes(jobRow(id)?.state) && jobRow(id), { timeout, every: 1000, what: `job ${id}` });

async function stopRun() {
  const stopWav = await speech("Stop.");
  const count = await speech(
    "This is an automated voice test and I am counting slowly, one, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty, twenty one, twenty two, twenty three, twenty four, twenty five, twenty six, twenty seven, twenty eight, twenty nine, thirty",
    { continuous: true },
  );
  return testRun("fix5-5d", async (run) => {
    const { browser, context } = await launch(run);
    try {
      const call = await Call.open(context);
      const s3 = await call.start();
      await sleep(2000);
      const jobB = await call.type(task("one random gemstone", "The lantern stone is <the gemstone>. The lantern is painted green and hangs beside the north door. It was checked this morning and works well."));
      const jobC = await call.type(task("one random river in South America", "The test river is <the river>. Its gauge sits under an old stone bridge. It was read at noon today."));
      await call.say(count, { loop: true });
      await waitFinal(jobB.id);
      await waitFinal(jobC.id);
      await call.hush();
      const firstOffer = await until(async () => (await call.events("result.offered")).at(0), { timeout: 90000, every: 100, what: "first result offered" });
      await until(async () => (await call.events("session.output_transcript.delta")).some((e) => e.ts > firstOffer.ts), { timeout: 30000, every: 50, what: "first result being read" });
      await sleep(700);
      const stop = await call.say(stopWav);
      await sleep(31000);
      const stopSql = "SELECT MIN(at) AS at,MIN(start_ms) AS start_ms FROM fragments WHERE session=? AND role='user' AND at>=? AND text LIKE '%top%'";
      const stopFrag = await until(() => query(stopSql, s3, stop.startedAt)[0]?.at && query(stopSql, s3, stop.startedAt)[0], { timeout: 5000, what: "stop fragment" });
      const from = stopFrag.at, to = stopFrag.at + 30000;
      const sqlA = "SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND start_ms>?+1000 AND start_ms<=?+31000";
      const sqlAll = "SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<=?";
      const sqlD = "SELECT job,state,session,updated FROM deliveries WHERE session=? AND updated>? AND updated<=?";
      const sqlW = "SELECT id,state,updated FROM jobs WHERE id IN (?,?)";
      const assistant = query(sqlA, s3, stopFrag.start_ms, stopFrag.start_ms);
      const received = query(sqlAll, s3, from, to);
      const deliveries = query(sqlD, s3, from, to);
      const waiting = query(sqlW, jobB.id, jobC.id);
      const second = waiting.find((j) => j.id !== firstOffer.job);
      const secondWasWaiting = Boolean(second && second.updated < from && !query("SELECT 1 FROM deliveries WHERE job=? AND updated<=?", second.id, to).length);
      const pass = assistant.length === 0 && deliveries.length === 0 && secondWasWaiting;
      const r = { run: run.name, session: s3, stopFragment: stopFrag, sql: { stopSql, sqlA, sqlAll, sqlD, sqlW }, assistant, received, deliveries, waiting, secondWasWaiting, transcript: turns(s3), pass };
      out.runs.push(r);
      console.log(`\n=== 5d (1c rerun) ${pass ? "PASS" : "FAIL"} session=${s3}`);
      console.log(`SQL: ${stopSql}  ARGS: ${JSON.stringify([s3, stop.startedAt])}\nROWS: ${JSON.stringify(stopFrag)}`);
      console.log(`SQL: ${sqlA}  ARGS: ${JSON.stringify([s3, stopFrag.start_ms, stopFrag.start_ms])}\nROWS: ${JSON.stringify(assistant)}`);
      console.log(`SQL: ${sqlAll}  ARGS: ${JSON.stringify([s3, from, to])}\nROWS: ${JSON.stringify(received)}`);
      console.log(`SQL: ${sqlD}  ARGS: ${JSON.stringify([s3, from, to])}\nROWS: ${JSON.stringify(deliveries)}`);
      console.log(`SQL: ${sqlW}  ARGS: ${JSON.stringify([jobB.id, jobC.id])}\nROWS: ${JSON.stringify(waiting)}`);
      console.log(`first offered job=${firstOffer.job}; second result final and still waiting=${secondWasWaiting}`);
      console.log(`TRANSCRIPT ${JSON.stringify(turns(s3).map((t) => [t.role, t.start_ms, t.text]))}`);
      await call.end();
      return r;
    } finally {
      await browser.close();
    }
  });
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  try {
    if (check === "5abc") {
      const n = Number(process.argv[3] || 5);
      const wav = splice([await speech("So can you check... uh..."), { silence: 1.5 }, await speech("what time it is in Tokyo.")], "fix5-pause");
      logger.info("pause utterance", { offsets: wav.offsets });
      console.log(`WAV ${wav.file} parts [start,end] s: ${JSON.stringify(wav.offsets)}`);
      for (let i = 1; i <= n; i++) {
        const { cleanup } = await pauseRun(i, wav);
        out.runs.at(-1).cleanup = cleanup;
        if (i < n) await sleep(60000); // low Azure TPM cap: space calls about a minute apart
      }
      const v = out.runs.map((r) => r.verdict);
      const pass5a = v.filter((x) => x.pass5a).length, pass5b = v.filter((x) => x.pass5b).length, pass5c = v.filter((x) => x.pass5c).length;
      out.summary = { runs: v.length, pass5a, pass5b, pass5c, latencies: v.map((x) => x.latencyMs) };
      console.log(`\nSUMMARY 5a ${pass5a}/${v.length} (need ${v.length}/${v.length}) | 5b ${pass5b}/${v.length} (need ${v.length}/${v.length}) | 5c ${pass5c}/${v.length} (need >=4/5) | latencies ms ${JSON.stringify(out.summary.latencies)}`);
    } else if (check === "5d") {
      const { cleanup } = await stopRun();
      out.runs.at(-1).cleanup = cleanup;
    } else if (check === "judge") {
      // Re-measure earlier 5a-5c runs from state.sqlite (fragments and jobs of each test conversation).
      const offsets = [[0, 1.1994791666666667], [1.1994791666666667, 2.699479166666667], [2.699479166666667, 3.76725]];
      const v = [];
      for (const conversation of process.argv.slice(3)) {
        const frags = query(FRAG_SQL, conversation), jobs = query(JOB_SQL, conversation);
        const verdict = judge(frags, jobs, offsets);
        v.push(verdict);
        out.runs.push({ conversation, verdict });
        console.log(`\n=== ${conversation}\nSQL: ${FRAG_SQL}\nSQL: ${JOB_SQL}   jobs=${jobs.length}`);
        for (const f of frags) console.log(`  ${f.role.padEnd(9)} start_ms=${String(f.start_ms).padStart(6)} end_ms=${String(f.end_ms).padStart(6)} at=${f.at} ${JSON.stringify(f.text)}`);
        console.log(`VERDICT 5a=${verdict.pass5a} 5b=${verdict.pass5b} 5c=${verdict.pass5c} latencyMs=${verdict.latencyMs} inPause=${JSON.stringify(verdict.assistantInPause.map((f) => f.text).join(""))} answers=${verdict.answers.length} jobs=${verdict.jobs}`);
      }
      console.log(`\nSUMMARY 5a ${v.filter((x) => x.pass5a).length}/${v.length} | 5b ${v.filter((x) => x.pass5b).length}/${v.length} | 5c ${v.filter((x) => x.pass5c).length}/${v.length}`);
    } else throw new Error("Usage: fix5.mjs 5abc [runs] | 5d | judge <conversation>...");
  } finally {
    out.finished = new Date().toISOString();
    console.log(`\nResults: ${save()}`);
  }
}
