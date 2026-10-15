// Recount a fix1-silent.mjs results file straight from state.sqlite (read-only).
//   node scripts/live-e2e/fix1-silent-recount.mjs logs/live-e2e/fix1-silent-<label>-<ts>.json
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const d = new DatabaseSync(process.env.HOME+"/.local/state/jarvis-voice/state.sqlite",{readOnly:true});
const o = JSON.parse(readFileSync(process.argv[2]));
const sql = "SELECT (SELECT COUNT(*) FROM fragments WHERE session=? AND role='assistant' AND at < COALESCE((SELECT MIN(at) FROM fragments WHERE session=? AND role='user'), 9e15)) AS assistant_before_user, (SELECT COUNT(*) FROM fragments WHERE session=? AND role='user') AS user_fragments, (SELECT COUNT(*) FROM deliveries WHERE session=?) AS deliveries";
console.log("SQL:", sql);
let n=0;
for (const r of o.runs) { const x=d.prepare(sql).get(r.session,r.session,r.session,r.session); if (x.assistant_before_user) n++; console.log(r.run, r.session, JSON.stringify(x)); }
console.log(`calls that spoke first: ${n} of ${o.runs.length}`);
