// Normal-conversation live check (docs/evidence/conversation.md). Each call is its own TestRun (its
// own test conversation, never the owner's; cleanup.mjs always runs). It connects, says "Hey
// Jarvis, how's it going?", pauses mid-sentence, asks the time in Tokyo, types a Hermes request
// (disk space), asks the capital of France, hears the result, says "Stop." and asks what we were
// just talking about. convo-judge.mjs measures each call from state.sqlite fragments.
//   node scripts/live-e2e/convo.mjs [count=1]
//   node scripts/live-e2e/convo.mjs judge <results.json>     re-measure saved runs from state.sqlite
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, testRun, turns } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { trace, check } from "./trace.mjs";
import { judgeConvo } from "./convo-judge.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const STOP = resolve(dir, "convo.stop");
const FRAG_SQL = "SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid";
const lastA = (s) => query("SELECT MAX(at) at FROM fragments WHERE session=? AND role='assistant'", s)[0]?.at || 0;
const answered = (s, after) => until(() => lastA(s) > after, { timeout: 25000, what: "answer" }).catch(() => log("NO ANSWER"));
const quiet = (s, ms, t = 60000) => until(() => Date.now() - lastA(s) > ms, { timeout: t, what: "quiet" }).catch(() => null);

const wallMarks = (wall) => Object.fromEntries(Object.entries(wall).map(([k, w]) => [k, [w.startedAt, w.endedAt]]));
function judge(r) {
  const frags = query(FRAG_SQL, r.session);
  const result = query("SELECT result FROM jobs WHERE id=?", r.job)[0]?.result || "";
  const deliveries = query("SELECT job,state FROM deliveries WHERE session=?", r.session);
  const jobs = query("SELECT id,state,substr(request,1,80) request FROM jobs WHERE session=?", r.session);
  const resultAt = query("SELECT MIN(at) at FROM audit WHERE kind='delivery.injected' AND json_extract(payload,'$.job')=? AND json_extract(payload,'$.session')=?", r.job, r.session)[0]?.at ?? null;
  return { frags, result, resultAt, deliveries, jobs, verdict: judgeConvo({ frags, marks: r.marks, result, deliveries, resultAt }) };
}

async function convoRun(i, A) {
  return testRun(`convo-${i}`, async (run) => {
    const { browser, context } = await launch(run);
    try {
      let call, s;
      for (let attempt = 1; ; attempt++) {
        call = await Call.open(context);
        try {
          s = await call.start();
          break;
        } catch (err) {
          if (!err.connect || attempt === 3) throw err;
          log(`[connect] attempt ${attempt} failed: ${err.message}; retrying in 60 s`);
          await call.page.close();
          await sleep(60000);
        }
      }
      log("connected", s);
      const wall = {};
      const say = async (name, wav) => (wall[name] = await call.say(wav));
      await sleep(6000);
      await say("hi", A.hi); await answered(s, wall.hi.endedAt); await quiet(s, 3000);
      await say("p1", A.p1); await sleep(3000);
      await say("p2", A.p2); await answered(s, wall.p2.endedAt); await quiet(s, 3000);
      const job = (await call.type("How much free disk space is left on this server?")).id;
      log("typed request, job", job);
      await sleep(2000);
      await say("france", A.france); await answered(s, wall.france.endedAt); await quiet(s, 3000);
      await until(() => query("SELECT 1 FROM audit WHERE kind='result.playback_observed' AND json_extract(payload,'$.job')=?", job).length,
        { timeout: 240000, every: 1000, what: "result read" }).catch((e) => log("no playback:", e.message));
      await quiet(s, 3000, 90000);
      await say("stop", A.stop); await sleep(5000);
      await say("last", A.last); await answered(s, wall.last.endedAt); await quiet(s, 4000);
      const id = call.callId(s);
      await call.end();
      const marks = wallMarks(wall);
      return { run: run.name, conversation: await run.conversationId(), session: s, callId: id, job, wall, marks };
    } finally {
      await browser.close();
    }
  });
}

function print(i, r) {
  console.log(`\n=== run ${i} ${r.run} conversation=${r.conversation} session=${r.session} call=${r.callId}`);
  console.log(`marks (wall ms, [start, end] of each utterance): ${JSON.stringify(r.marks)}`);
  if (r.wall) console.log(`mic peak level sent while each utterance played: ${JSON.stringify(Object.fromEntries(Object.entries(r.wall).map(([k, w]) => [k, w.peak ?? null])))}`);
  if (r.wall) console.log(`RTP audio packets/s sent while each utterance played: ${JSON.stringify(Object.fromEntries(Object.entries(r.wall).map(([k, w]) => [k, w.packetsPerSecond ?? null])))}`);
  console.log(`SQL: ${FRAG_SQL}   ARGS: ["${r.session}"]`);
  for (const f of r.frags) console.log(`  ${f.role.padEnd(9)} start_ms=${String(Math.round(f.start_ms)).padStart(6)} at=${f.at} ${JSON.stringify(f.text)}`);
  console.log(`jobs: ${JSON.stringify(r.jobs)}  deliveries: ${JSON.stringify(r.deliveries)}  delivery.injected at=${r.resultAt}  result: ${JSON.stringify(r.result)}`);
  console.log(`VERDICT ${JSON.stringify(r.verdict)}`);
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const out = { started: new Date().toISOString(), build: (await (await fetch("http://127.0.0.1:8787/healthz")).json()).buildId, runs: [] };
  const file = resolve(dir, `convo-${Date.parse(out.started)}.json`);
  const save = () => writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  try {
    if (process.argv[2] === "judge") {
      for (const r of JSON.parse(readFileSync(process.argv[3], "utf8")).runs) out.runs.push({ ...r, ...judge({ ...r, marks: wallMarks(r.wall) }), marks: wallMarks(r.wall) });
      out.runs.forEach((r, i) => print(i + 1, r));
    } else {
      const A = {
        hi: await speech("Hey Jarvis, how's it going?"),
        p1: await speech("So can you tell me, uh,"),
        p2: await speech("what time it is in Tokyo right now?"),
        france: await speech("While that's running, what's the capital of France?"),
        stop: await speech("Stop."),
        last: await speech("Okay, thanks. What were we just talking about?"),
      };
      const n = Number(process.argv[2] || 1);
      for (let i = 1; i <= n; i++) {
        let r;
        try {
          const { result, cleanup } = await convoRun(i, A);
          r = { ...result, cleanup, ...judge(result) };
          const t = trace(r.callId), c = check(t);
          r.trace = { lines: t.lines.length, missing: c.missing, gaps: c.gaps };
        } catch (err) {
          r = { run: `convo-${i}`, error: err.message, verdict: { pass: false, checks: {} } };
        }
        out.runs.push(r);
        if (r.frags) print(i, r); else console.log(`\n=== run ${i} ERROR ${r.error}`);
        console.log("conversation:"); for (const t of r.session ? turns(r.session) : []) console.log(`  ${t.role.padEnd(9)} ${t.text.trim()}`);
        save();
        if (i < n) await sleep(45000); // low Azure TPM cap: space calls apart
        // Stop a set between calls (never mid-call, so every call's cleanup runs): touch this file.
        if (existsSync(STOP)) { rmSync(STOP); console.log("stopped by", STOP); break; }
      }
    }
    console.log("\nRAW VERDICTS");
    const names = ["silentOnConnect", "silentInPause", "hiNoTime", "tokyoTime", "franceParis", "resultOnceEnglish", "silentAfterStop", "afterStopAnswered"];
    for (const [i, r] of out.runs.entries())
      console.log(`${i + 1} ${r.verdict.pass ? "PASS" : "FAIL"} ${names.map((n) => `${n}=${r.verdict.checks[n]?.pass ? "ok" : "FAIL"}`).join(" ")} owner+${r.cleanup?.ownerConversationNewFragments ?? "?"}${r.error ? ` error=${r.error}` : ""}`);
    out.summary = { runs: out.runs.length, pass: out.runs.filter((r) => r.verdict.pass).length };
    console.log(`SUMMARY ${out.summary.pass}/${out.summary.runs} conversations pass every check | build ${out.build}`);
  } finally {
    out.finished = new Date().toISOString();
    save();
    console.log(`\nResults: ${file}`);
  }
}
