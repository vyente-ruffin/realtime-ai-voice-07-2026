// Prove no memory or result text is in the audit rows: every sentence (>= 20 chars) of the
// prepared memory sections and of each job result is searched for in the audit payloads.
//   node scripts/live-e2e/audit-privacy.mjs [sinceMs]
import { query } from "./harness.mjs";

const since = Number(process.argv[2] || 0);
const rows = query("SELECT id,kind,payload FROM audit WHERE at>=?", since);
const sends = rows.filter((r) => r.kind.startsWith("model."));
const memory = query("SELECT value FROM cache WHERE key LIKE 'prepared:%'").flatMap((r) => JSON.parse(r.value)).map((m) => m.content || "");
const results = query("SELECT result FROM jobs WHERE updated>=? AND result IS NOT NULL", since).map((r) => r.result);
const pieces = [...memory, ...results].flatMap((t) => t.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter((s) => s.length >= 20);
const hits = [];
for (const piece of pieces) for (const r of rows) if (r.payload.includes(piece)) hits.push({ audit: r.id, kind: r.kind, piece: piece.slice(0, 20) + "…" });
const contentFields = sends.filter((r) => /"(content|text|delta|result|instructions)"\s*:/.test(r.payload));
console.log(JSON.stringify({ since, auditRows: rows.length, modelRows: sends.length, memorySentences: memory.length && pieces.length, resultTexts: results.length, hits: hits.length, contentFieldsInModelRows: contentFields.length }));
if (hits.length) console.log(JSON.stringify(hits.slice(0, 20)));
process.exit(hits.length || contentFields.length ? 1 : 0);
