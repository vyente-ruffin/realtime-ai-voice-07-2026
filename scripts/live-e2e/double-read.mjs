// Part 2 live check: each requested result is spoken exactly once.
//   node scripts/live-e2e/double-read.mjs earlier [N]   the 1b shape: the job finishes in an earlier
//                                                     call; a new call; "yes, tell me"
//   node scripts/live-e2e/double-read.mjs same [N]      a result from the same call
// Counted from state.sqlite: assistant fragment runs (turns) that say the result's key phrase,
// model.send rows with purpose=result for that job's delivery offers, and jobs the call created
// (a re-run of the yes would be one).
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, testRun } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { measure } from "./double-read-judge.mjs";

const [mode = "earlier", n = "1"] = process.argv.slice(2);
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const task = (choice, sentences) =>
  `Automated voice test for Hermes. Choose ${choice} yourself, then reply with exactly these sentences and nothing else, without using any tools: ${sentences}`;
const FINAL = ["completed", "failed", "cancelled", "interrupted"];
const yes = await speech("Yes, tell me.");
const lastAssistant = (session) => query("SELECT MAX(at) AS at FROM fragments WHERE session=? AND role='assistant'", session)[0]?.at || 0;
const quiet = (session, ms, timeout) => until(() => Date.now() - lastAssistant(session) > ms, { timeout, what: "assistant quiet" }).catch(() => null);

/** Start a call, retrying a failed start (Azure has answered a fresh session with 400 once in
 * about 60 starts) after 60 s, as fix5.mjs does; each failure is recorded. */
async function start(call, context) {
  for (let attempt = 1; ; attempt++) {
    try {
      return { call, session: await call.start() };
    } catch (err) {
      if (!err.connect || attempt === 3) throw err;
      out.connectFailures = [...(out.connectFailures || []), { at: new Date().toISOString(), attempt, error: err.message }];
      console.log(`[connect] attempt ${attempt} failed: ${err.message.split("\n").at(-1)}; retrying in 60 s`);
      await call.page.close();
      await sleep(60000);
      call = await Call.open(context);
    }
  }
}
const out = { mode, started: new Date().toISOString(), runs: [] };
for (let i = 1; i <= Number(n); i++) {
  const { result } = await testRun(`double-${mode}`, async (run) => {
    const { browser, context } = await launch(run);
    try {
      let { call, session } = await start(await Call.open(context), context);
      await sleep(2000);
      const job = await call.type(task("one random uncommon bird species", "The test bird is <the species>. It was seen at the east pond."));
      let since;
      if (mode === "earlier") {
        await call.end();
        await call.page.close();
        await until(() => FINAL.includes(query("SELECT state FROM jobs WHERE id=?", job.id)[0]?.state), { timeout: 300000, every: 1000, what: "job final" });
        ({ call, session } = await start(await Call.open(context), context));
        // Count the whole new call: a made-up result before the waiting line counts too.
        since = 0;
        // The single waiting line, then V's yes.
        await until(() => query("SELECT 1 FROM audit WHERE kind='result.waiting_offered' AND json_extract(payload,'$.session')=?", session).length, { timeout: 30000, what: "waiting line" });
        await sleep(3000);
        await quiet(session, 2000, 20000);
        out.yesAt = (await call.say(yes)).startedAt;
      } else since = Date.now();
      await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND session=? AND state='injected'", job.id, session).length, { timeout: 300000, every: 1000, what: "result injected" });
      await until(() => query("SELECT 1 FROM audit WHERE kind='result.playback_observed' AND json_extract(payload,'$.job')=? AND json_extract(payload,'$.session')=?", job.id, session).length, { timeout: 60000, what: "playback" }).catch(() => null);
      // Stay silent long enough for a second reading to show up.
      await sleep(5000);
      await quiet(session, 12000, 90000);
      await call.end();
      return { conversation: run.conversation, session, job: job.id, callId: call.callId(session), ...measure(job.id, session, since) };
    } finally {
      await browser.close();
    }
  });
  out.runs.push(result);
  console.log(`\nRUN ${mode} ${i}: ${result.pass ? "PASS" : "FAIL"} ${JSON.stringify({ job: result.job, session: result.session, callId: result.callId, key: result.key, spokenRuns: result.spokenRuns, occurrences: result.occurrences, statements: result.statements, statementRuns: result.statementRuns, commentarySends: result.commentarySends, offers: result.offers, rerunJobs: result.rerunJobs, delegations: result.delegations })}`);
  for (const line of result.transcript) console.log(`  ${line}`);
}
const passed = out.runs.filter((r) => r.pass).length;
console.log(`\nSUMMARY ${mode} ${passed}/${out.runs.length} spoken exactly once`);
const file = resolve(dir, `double-${mode}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
console.log(`Results: ${file}`);
process.exit(passed === out.runs.length ? 0 : 1);
