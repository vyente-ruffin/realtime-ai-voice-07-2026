// Fix 7 live checks 7a/7b (docs/VOICE-FIX-PLAN.md, "handle a dropped call cleanly"). Each run is a
// TestRun (its own test conversation, never the owner's; cleanup.mjs always runs). A job with a long,
// fixed result is started; 2 s after the voice starts reading it, the page's RTCPeerConnection is
// closed (not the call ended), so the app's own reconnect path runs. Pass/fail is measured from
// state.sqlite (fragments, jobs, deliveries) with the rules in fix7-judge.mjs.
//   node scripts/live-e2e/fix7.mjs [N]     N runs (default 3), about a minute apart
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, testRun } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { verdict7a, verdict7b } from "./fix7-judge.mjs";

const runs = Number(process.argv[2] || 3);
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const out = { started: new Date().toISOString(), runs: [] };
const FINAL = ["completed", "failed", "cancelled", "interrupted"];
const SILENT_MS = 25000;
// Hermes picks the species and writes the sentences, so the voice cannot speak the result (or
// "continue" it) from the request text; only the job result holds them.
const TASK = "Automated voice test for Hermes. Choose one random uncommon sea bird species yourself. Then write six short plain sentences about a lighthouse keeper counting that bird's nests this spring, with made-up numbers and details. The first sentence must be exactly: The harbor bird is <the species>. Reply with only those six sentences, without using any tools.";
const FRAG_SQL = "SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid";
const JOB_SQL = "SELECT id,session,state,result,created,updated FROM jobs WHERE id=?";
const DELIVERY_SQL = "SELECT job,state,session,event,updated FROM deliveries WHERE job=?";
const audio = { yes: await speech("Yes, finish.") };

function lastAssistantAt(session) {
  return query("SELECT MAX(at) AS at FROM fragments WHERE session=? AND role='assistant'", session)[0].at || 0;
}
function show(label, session) {
  const rows = query(FRAG_SQL, session);
  console.log(`--- ${label} transcript (SQL: ${FRAG_SQL} [${session}])`);
  for (const r of rows) console.log(`${r.at} ${r.role.padEnd(9)} [${r.start_ms}-${r.end_ms}] ${JSON.stringify(r.text)}`);
  return rows;
}

for (let i = 0; i < runs; i++) {
  if (i) await sleep(60000);
  const record = { run: i + 1 };
  out.runs.push(record);
  try {
    const { cleanup } = await testRun("fix7", async (run) => {
      const { browser, context } = await launch(run);
      try {
        const call = await Call.open(context);
        const s1 = await call.start();
        Object.assign(record, { testRun: run.name, conversation: run.conversation, s1 });
        console.log(`\n=== run ${i + 1}: test run ${run.name}, conversation ${run.conversation}, session ${s1}`);
        await sleep(3000);
        const job = await call.type(TASK);
        record.job = job.id;
        await until(() => FINAL.includes(query(JOB_SQL, job.id)[0]?.state), { timeout: 300000, every: 1000, what: "job final" });
        const offer = await until(async () => (await call.events("result.offered")).find((e) => e.job === job.id), { timeout: 120000, every: 100, what: "result offered" });
        const speaking = await until(async () => (await call.events("session.output_transcript.delta")).find((e) => e.ts > offer.ts && /harbor|bird/i.test(e.delta || "")), { timeout: 30000, every: 50, what: "result being read" });
        await sleep(Math.max(0, speaking.ts + 2000 - Date.now()));
        const drop = await call.drop();
        Object.assign(record, { offeredAt: offer.ts, readingAt: speaking.ts, ...drop, s2: drop.session });
        console.log(`dropped at ${drop.droppedAt} (${drop.droppedAt - speaking.ts} ms into the answer); reconnected session ${drop.session} at ${drop.reconnectedAt}`);
        await sleep(SILENT_MS);
        // Let a line that started inside the window finish before the user answers.
        await until(() => Date.now() - lastAssistantAt(drop.session) > 3000, { timeout: 30000, what: "assistant quiet" }).catch(() => null);
        const yes = await call.say(audio.yes);
        record.yes = yes;
        await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND session=? AND state='injected'", job.id, drop.session).length, { timeout: 60000, what: "redelivery" }).catch(() => null);
        await sleep(5000);
        await until(() => Date.now() - lastAssistantAt(drop.session) > 5000, { timeout: 90000, what: "answer finished" }).catch(() => null);
        await call.end();
        const errors = await call.events("app.error");
        if (errors.length) console.log(`PAGE ERRORS: ${JSON.stringify(errors.map((e) => e.message))}`);
        record.events = (await call.events()).filter((e) => /connection\.lost|cutoff|result\.|delivery\./.test(e.type)).map(({ ts, type, job: j, reason }) => ({ ts, type, job: j, reason }));
      } finally {
        await browser.close();
      }
      const j = query(JOB_SQL, record.job)[0];
      const key = (j.result || "").match(/harbor bird is ([^.]+)\./i)?.[1]?.trim() || "";
      console.log(`SQL: ${JOB_SQL} [${record.job}]\n${JSON.stringify({ ...j, result: j.result }, null, 1)}`);
      const f1 = show("dropped session s1", record.s1);
      const f2 = show("reconnected session s2", record.s2);
      const priorSpoken = f1.filter((f) => f.role === "assistant").map((f) => f.text).join("");
      const yesFrag = f2.find((f) => f.role === "user" && f.at >= record.yes.startedAt);
      const yesAt = yesFrag?.at ?? record.yes.startedAt;
      record.verdict7a = verdict7a({ fragments: f2, until: yesAt, answer: `${j.result} ${priorSpoken}` });
      const delivery = query(DELIVERY_SQL, record.job)[0];
      console.log(`SQL: ${DELIVERY_SQL} [${record.job}]\n${JSON.stringify(delivery)}`);
      const spoken = f2.filter((f) => f.role === "assistant" && f.at > yesAt).map((f) => f.text).join("");
      // Received before the re-delivery was injected (deliveries.updated) can't come from the result.
      const early = f2.filter((f) => f.role === "assistant" && f.at > yesAt && (!delivery || f.at <= delivery.updated)).map((f) => f.text).join("");
      const rerun = query("SELECT id,delegation,created,substr(result,1,80) AS result FROM jobs WHERE conversation=? AND session=?", record.conversation, record.s2);
      console.log(`SQL: SELECT id,delegation,created,substr(result,1,80) AS result FROM jobs WHERE conversation=? AND session=? [${record.conversation}, ${record.s2}]\n${JSON.stringify(rerun)}`);
      record.verdict7b = verdict7b({ spoken, result: j.result || "", key, delivery, yesAt, session: record.s2, early, rerunJobs: rerun.length });
      const cutAudit = query("SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN ('session.cut_off','result.cut_off_offered','delivery.consent','delivery.declined') ORDER BY at", record.conversation);
      console.log(`SQL: SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN (...) [${record.conversation}]\n${JSON.stringify(cutAudit)}`);
      console.log(`7a run ${i + 1}: ${record.verdict7a.pass ? "PASS" : "FAIL"} ${JSON.stringify(record.verdict7a)}`);
      console.log(`7b run ${i + 1}: ${record.verdict7b.pass ? "PASS" : "FAIL"} ${JSON.stringify(record.verdict7b)}`);
    });
    record.cleanup = cleanup;
  } catch (err) {
    record.error = err.message;
    console.log(`run ${i + 1} ERROR: ${err.message}`);
  }
}
out.finished = new Date().toISOString();
const file = resolve(dir, `fix7-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
const n7a = out.runs.filter((r) => r.verdict7a?.pass).length, n7b = out.runs.filter((r) => r.verdict7b?.pass).length;
console.log(`\nSUMMARY 7a ${n7a}/${runs} PASS, 7b ${n7b}/${runs} PASS. Results: ${file}`);
