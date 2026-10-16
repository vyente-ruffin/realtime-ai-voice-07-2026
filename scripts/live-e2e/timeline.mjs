// One test conversation in time order from state.sqlite: fragments (text, audio-clock start) and
// audit rows (model.send purpose and length only, never content). Read-only.
//   node scripts/live-e2e/timeline.mjs <conversation>
import { DatabaseSync } from "node:sqlite";
import { statePath } from "./harness.mjs";
const d = new DatabaseSync(statePath, { readOnly: true });
const conv = process.argv[2];
const rows = [];
for (const f of d.prepare("select role,text,at,start_ms from fragments where conversation=?").all(conv)) rows.push({ at: f.at, s: `${f.role === "user" ? "U" : "A"} ${JSON.stringify(f.text)} (aud ${Math.round(f.start_ms)})` });
for (const a of d.prepare("select kind,payload,at from audit where conversation=? and kind not in ('call.stats','connection.playback','connection.state')").all(conv)) {
  const p = JSON.parse(a.payload); const det = p.detail || p;
  let s = a.kind;
  if (a.kind === "model.send") s = `  send ${det.eventType} ${det.purpose} len=${det.contentLength}`;
  else if (a.kind === "model.ack") s = `  ack ${det.purpose || ""} ${det.latencyMs ?? ""}`;
  else s = `  ${a.kind} ${JSON.stringify(det).slice(0, 160)}`;
  rows.push({ at: a.at, s });
}
rows.sort((a, b) => a.at - b.at);
const t0 = rows[0]?.at;
for (const r of rows) console.log(((r.at - t0) / 1000).toFixed(2).padStart(7), r.s);
