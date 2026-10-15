// Part 1 live check (logging covers the whole flow): one call that connects, asks a question that
// needs a Hermes job, hears the result, says stop, asks something else and hangs up. Then the
// trace is built from the logs alone (trace.mjs) and compared with the page's own wire log, so a
// step that happened without a record shows up as a gap.
//   node scripts/live-e2e/logging.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, until, query, testRun } from "./harness.mjs";
import { speech } from "./tts.mjs";
import { trace, check, print } from "./trace.mjs";

const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const audio = {
  ask: await speech("How much free disk space is left on this server?"),
  stop: await speech("Stop."),
  other: await speech("What's the capital of France?"),
};
const lastAssistant = (session) => query("SELECT MAX(at) AS at FROM fragments WHERE session=? AND role='assistant'", session)[0]?.at || 0;
const quiet = (session, ms, timeout) =>
  until(() => Date.now() - lastAssistant(session) > ms, { timeout, what: "assistant quiet" }).catch(() => null);

const { result } = await testRun("logging", async (run) => {
  const { browser, context } = await launch(run);
  try {
    const call = await Call.open(context);
    const session = await call.start();
    console.log(`test run ${run.name}, conversation ${run.conversation}, session ${session}`);
    await sleep(4000);
    const asked = await call.say(audio.ask);
    const job = await until(() => query("SELECT id,state,run_id FROM jobs WHERE session=? ORDER BY created LIMIT 1", session)[0], { timeout: 60000, what: "job" });
    await until(() => query("SELECT 1 FROM deliveries WHERE job=? AND state='injected'", job.id).length, { timeout: 300000, every: 1000, what: "result injected" });
    // Hear the whole result: the page reports playback after the result's speech, then a quiet gap.
    await until(() => query("SELECT 1 FROM audit WHERE kind='result.playback_observed' AND json_extract(payload,'$.job')=?", job.id).length, { timeout: 60000, what: "result playback" });
    await quiet(session, 3000, 90000);
    const stop = await call.say(audio.stop);
    await sleep(6000);
    const other = await call.say(audio.other);
    await until(() => lastAssistant(session) > other.endedAt, { timeout: 30000, what: "answer to the other question" }).catch(() => null);
    await quiet(session, 4000, 60000);
    const wire = await call.wire();
    await call.end();
    return { session, callId: call.callId(session), job: job.id, asked, stop, other, wire };
  } finally {
    await browser.close();
  }
});

const t = trace(result.callId);
const c = check(t);
print(t, c);
// Wire vs. logs: every append the page put on the data channel, and every ack it received,
// has its own audit row with the same event id.
const sends = t.lines.filter((l) => l.step === "model.send").map((l) => l.ids.event);
const acks = t.lines.filter((l) => l.step === "model.ack").map((l) => l.ids.event);
const outAppends = result.wire.filter((w) => w.dir === "out" && /\.append$/.test(w.type));
const inAcks = result.wire.filter((w) => w.dir === "in" && /appended$/.test(w.type));
const unlogged = [...outAppends.filter((w) => !sends.includes(w.event_id)).map((w) => `out ${w.type} ${w.event_id}`),
  ...inAcks.filter((w) => !acks.includes(w.client_event_id)).map((w) => `in ${w.type} ${w.client_event_id}`)];
const delegations = result.wire.filter((w) => w.dir === "in" && w.type === "session.delegation.created");
const unloggedDelegations = delegations.filter((w) => !t.lines.some((l) => l.step === "delegation.received" && l.ids.delegation === w.delegation_id));
console.log(`\nWIRE appends out=${outAppends.length} acks in=${inAcks.length} delegations in=${delegations.length}; audit model.send=${sends.length} model.ack=${acks.length}`);
console.log(`WIRE WITHOUT AUDIT ROW ${JSON.stringify([...unlogged, ...unloggedDelegations.map((w) => `delegation ${w.delegation_id}`)])}`);
const pass = c.pass && !unlogged.length && !unloggedDelegations.length;
console.log(`LOGGING ${pass ? "PASS" : "FAIL"} callId=${result.callId}`);
const file = resolve(dir, `logging-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ result, check: c }, null, 1), { mode: 0o600 });
console.log(`Results: ${file}`);
process.exit(pass ? 0 : 1);
