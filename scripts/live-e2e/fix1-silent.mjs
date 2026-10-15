// Fix 1 silent-connect regression (docs/evidence/fix1-regression.md). Each run is its own TestRun
// (own test conversation, cleanup.mjs after it, Chrome closed after it), one call at a time:
// connect, say nothing for 30 s, end. A run fails if the new session has any assistant fragment
// before its first user fragment (there is no user fragment, so: any assistant fragment).
// Measured from state.sqlite fragments/deliveries; what the page sent the model is kept as a pointer.
//   node scripts/live-e2e/fix1-silent.mjs [N] [label]   N runs (default 10)
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launch, Call, sleep, query, testRun } from "./harness.mjs";

const runs = Number(process.argv[2] || 10);
const label = process.argv[3] || "run";
const SILENT_MS = 30000;
const dir = resolve(import.meta.dirname, "../../logs/live-e2e");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const FRAG_SQL = "SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid";
const DELIVERY_SQL = "SELECT job,state,session,updated FROM deliveries WHERE session=?";
const out = { label, started: new Date().toISOString(), runs: [] };

for (let i = 0; i < runs; i++) {
  const record = { run: i + 1 };
  out.runs.push(record);
  try {
    const { cleanup } = await testRun("fix1-silent", async (run) => {
      const { browser, context } = await launch(run);
      try {
        const call = await Call.open(context);
        record.session = await call.start();
        record.startedAt = Date.now();
        Object.assign(record, { testRun: run.name, conversation: run.conversation });
        await sleep(SILENT_MS);
        const sent = (await call.events()).filter((e) => /appended|context|held|result\.|delivery\.|cut_?off/.test(e.type));
        record.sent = sent.map(({ ts, type, reason }) => ({ ts, type, reason }));
        await call.end();
      } finally {
        await browser.close();
      }
    });
    record.cleanup = { invalidated: cleanup.invalidated, owner: cleanup.ownerConversationNewFragments };
    const frags = query(FRAG_SQL, record.session);
    const firstUser = frags.find((f) => f.role === "user");
    const early = frags.filter((f) => f.role === "assistant" && (!firstUser || f.at < firstUser.at));
    const deliveries = query(DELIVERY_SQL, record.session);
    Object.assign(record, { fragments: frags, early, deliveries, spokeFirst: early.length > 0 });
    console.log(`\n=== ${label} call ${i + 1}: conversation ${record.conversation}, session ${record.session}`);
    console.log(`SQL: ${FRAG_SQL} [${record.session}]`);
    for (const f of frags) console.log(`  ${new Date(f.at).toISOString()} ${f.role.padEnd(9)} ${JSON.stringify(f.text)}`);
    if (!frags.length) console.log("  (no rows)");
    console.log(`SQL: ${DELIVERY_SQL} [${record.session}] -> ${JSON.stringify(deliveries)}`);
    const held = (record.sent || []).filter((e) => e.type === "memory.context.held").length;
    const memorySent = (record.sent || []).filter((e) => e.type === "memory.context.accepted").length;
    console.log(`page events: memory.context.held=${held} memory.context.accepted=${memorySent} session.thinking.appended=${(record.sent || []).filter((e) => e.type === "session.thinking.appended").length}`);
    console.log(`call ${i + 1}: ${record.spokeFirst ? "SPOKE FIRST" : "silent"} (assistant fragments before first user fragment: ${early.length})`);
  } catch (err) {
    record.error = err.message;
    console.log(`call ${i + 1} ERROR: ${err.message}`);
  }
  await sleep(3000);
}
out.finished = new Date().toISOString();
const file = resolve(dir, `fix1-silent-${label}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
const done = out.runs.filter((r) => !r.error);
console.log(`\nSUMMARY ${label}: ${done.filter((r) => r.spokeFirst).length} of ${done.length} calls spoke first (${out.runs.length - done.length} errors). Results: ${file}`);
