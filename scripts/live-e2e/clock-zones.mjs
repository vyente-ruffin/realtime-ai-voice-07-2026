// Other-city time live check (docs/evidence/clock-zones.md). Each call is its own TestRun (its
// own test conversation, never the owner's; cleanup.mjs always runs): say "Can you tell me what time it is in
// <city>?" and measure from state.sqlite `fragments` and `jobs` whether the spoken hour and
// minute match Intl for the city's IANA zone, within 1 minute, at the answer's first fragment.
//   node scripts/live-e2e/clock-zones.mjs [count=10] [first city index=0]
//   node scripts/live-e2e/clock-zones.mjs judge <conversation>:<zone>...   re-measure from state.sqlite
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, query, testRun } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { judgeZone } from "./clock-zones-judge.mjs";
import { getLogger } from "../../src/core/logger.js";

const logger = await getLogger("live-e2e.clock-zones");
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
// Varied offsets: whole hours, half hour (Kolkata), 45 minutes (Kathmandu), across the date line
// from the browser's Los Angeles (Auckland), southern-hemisphere daylight time (Sydney, Sao Paulo).
export const CITIES = [
  ["Tokyo", "Asia/Tokyo"], ["London", "Europe/London"], ["Sydney", "Australia/Sydney"],
  ["Kolkata", "Asia/Kolkata"], ["New York", "America/New_York"], ["Auckland", "Pacific/Auckland"],
  ["Kathmandu", "Asia/Kathmandu"], ["Dubai", "Asia/Dubai"], ["São Paulo", "America/Sao_Paulo"],
  ["Paris", "Europe/Paris"],
];
const FRAG_SQL = "SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE conversation=? ORDER BY at,rowid";
const JOB_SQL = "SELECT id,state,title,created,updated FROM jobs WHERE conversation=? ORDER BY created";
const out = { started: new Date().toISOString(), build: null, runs: [] };
const save = () => {
  const file = resolve(dir, `clock-zones-${Date.parse(out.started)}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  return file;
};
const print = (i, r) => {
  console.log(`\n=== run ${i} ${r.city} (${r.zone}) conversation=${r.conversation} session=${r.session}`);
  console.log(`SQL: ${FRAG_SQL}   ARGS: ["${r.conversation}"]`);
  for (const f of r.frags) console.log(`  ${f.role.padEnd(9)} start_ms=${String(f.start_ms).padStart(6)} at=${f.at} ${JSON.stringify(f.text)}`);
  console.log(`SQL: ${JOB_SQL}   ARGS: ["${r.conversation}"]\n  ${JSON.stringify(r.jobRows)}`);
  console.log(`VERDICT ${JSON.stringify(r.verdict)}`);
};

async function zoneRun(i, city, zone, wav) {
  return testRun(`clock-zones-${i}`, async (run) => {
    const conversation = await run.conversationId();
    const { browser, context } = await launch(run);
    try {
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
      const said = await call.say(wav);
      await sleep(12000);
      await call.end();
      const frags = query(FRAG_SQL, conversation);
      const jobRows = query(JOB_SQL, conversation);
      const verdict = judgeZone(frags, jobRows, zone);
      const r = { run: run.name, city, zone, conversation, session, said, frags, jobRows, verdict };
      out.runs.push(r);
      print(i, r);
      return r;
    } finally {
      await browser.close();
    }
  });
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  try {
    out.build = (await (await fetch("http://127.0.0.1:8787/healthz")).json()).buildId;
    if (process.argv[2] === "judge") {
      for (const [i, arg] of process.argv.slice(3).entries()) {
        const [conversation, zone] = arg.split(":");
        const frags = query(FRAG_SQL, conversation), jobRows = query(JOB_SQL, conversation);
        const r = { city: zone, zone, conversation, session: frags[0]?.session, frags, jobRows, verdict: judgeZone(frags, jobRows, zone) };
        out.runs.push(r);
        print(i + 1, r);
      }
    } else {
      const n = Number(process.argv[2] || 10), first = Number(process.argv[3] || 0);
      for (let i = 1; i <= n; i++) {
        const [city, zone] = CITIES[(first + i - 1) % CITIES.length];
        const wav = await speech(`Can you tell me what time it is in ${city}?`);
        logger.info("zone call", { city, zone });
        const { cleanup } = await zoneRun(i, city, zone, wav);
        out.runs.at(-1).cleanup = cleanup;
        if (i < n) await sleep(60000); // low Azure TPM cap: space calls about a minute apart
      }
    }
    const v = out.runs.map((r) => r.verdict);
    out.summary = { runs: v.length, pass: v.filter((x) => x.pass).length, jobs: v.reduce((a, x) => a + x.jobs, 0) };
    console.log("\nRAW VERDICTS");
    for (const [i, r] of out.runs.entries())
      console.log(`${i + 1} ${r.verdict.pass ? "PASS" : "FAIL"} ${r.city} ${r.zone} expected "${r.verdict.expected}" spoken "${r.verdict.spoken}" off ${r.verdict.minutesOff} min jobs ${r.verdict.jobs} answer ${JSON.stringify(r.verdict.answer)}`);
    console.log(`SUMMARY ${out.summary.pass}/${out.summary.runs} within 1 minute of Intl | Hermes jobs ${out.summary.jobs} | build ${out.build}`);
  } finally {
    out.finished = new Date().toISOString();
    console.log(`\nResults: ${save()}`);
  }
}
