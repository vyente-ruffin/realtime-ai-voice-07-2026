// Oddities in normal-conversation calls (convo.mjs) that the pass/fail judge doesn't fail: the
// second score of the autotune loop (docs/evidence/convo-20.md, docs/evidence/autotune.md). Fixed
// once Phase A starts; measured only from the saved results file plus state.sqlite job times.
//   node scripts/live-e2e/convo-oddities.mjs <convo-*.json> [more.json ...]
import { readFileSync } from "node:fs";
import { query } from "./harness.mjs";

const SAID = {
  hi: "Hey Jarvis, how's it going?",
  p1: "So can you tell me, uh,",
  p2: "what time it is in Tokyo right now?",
  france: "While that's running, what's the capital of France?",
  stop: "Stop.",
  last: "Okay, thanks. What were we just talking about?",
};
const ORDER = Object.keys(SAID);
const norm = (s) => String(s).toLowerCase().replace(/[’]/g, "'").replace(/\b([ap])\.m\./g, "$1m");
const wordsOf = (s) => norm(s).match(/[a-z0-9']+/g) || [];
const FILLERS = new Set(["uh", "um"]);
const text = (fs) => fs.map((f) => f.text).join("").trim();
const sentences = (s) => norm(s).split(/[.!?]+(?:\s|$)/).filter((x) => /\w/.test(x)).length;
const SLOW_MS = 3000;

export function oddities(r) {
  const out = [];
  if (!r.frags || !r.marks) return [{ kind: "crash", note: r.error || "no fragments" }];
  const m = r.marks, frags = r.frags;
  const a = frags.filter((f) => f.role === "assistant"), u = frags.filter((f) => f.role === "user" && f.start_ms < 1e12);
  const typedAt = query("SELECT created FROM jobs WHERE id=?", r.job)[0]?.created ?? m.france[0];
  const win = (fs, from, to) => fs.filter((f) => f.at >= from && f.at < to);
  // Words the voice never heard: each spoken utterance's words, in the user transcript from its
  // start to the next utterance's start (fillers like "uh" aside).
  for (const [i, k] of ORDER.entries()) {
    const heard = new Set(wordsOf(text(win(u, m[k][0], ORDER[i + 1] ? m[ORDER[i + 1]][0] : Infinity))));
    const missing = wordsOf(SAID[k]).filter((w) => !FILLERS.has(w) && !heard.has(w) && !heard.has(w.replace(/'s$/, "")));
    if (missing.length) out.push({ kind: "missingWords", note: `${k}: missing ${missing.join(" ")}` });
  }
  // Slow or no answer: first assistant fragment after the end of each question.
  const ends = { hi: m.p1[0], p2: typedAt, france: m.stop[0], last: Infinity };
  for (const k of Object.keys(ends)) {
    const first = a.find((f) => f.at > m[k][1] - 500 && f.at < ends[k]);
    if (!first) out.push({ kind: "noAnswer", note: k });
    else if (first.at - m[k][1] > SLOW_MS) out.push({ kind: "slowAnswer", note: `${k}: ${first.at - m[k][1]} ms` });
  }
  const hi = text(win(a, m.hi[0], m.p1[0]));
  if (/\b(running|task|tasks|nothing'?s? (going on|happening|on)|all quiet|idle|queue)\b/i.test(norm(hi)))
    out.push({ kind: "greetingStatus", note: hi });
  if (wordsOf(hi).length > 30) out.push({ kind: "longAnswer", note: `hi ${wordsOf(hi).length} words` });
  const tokyo = text(win(a, m.p2[0], typedAt));
  if (sentences(tokyo) > 1 || wordsOf(tokyo).length > 15) out.push({ kind: "longAnswer", note: `tokyo: ${tokyo}` });
  const readAt = r.resultAt ?? m.stop[0];
  const france = text(win(a, m.france[0], Math.min(readAt, m.stop[0])));
  if (sentences(france) > 1) out.push({ kind: "longAnswer", note: `france: ${france}` });
  const result = text(win(a, readAt, m.stop[0]));
  if (wordsOf(result).length > 35) out.push({ kind: "longAnswer", note: `result ${wordsOf(result).length} words` });
  // The recap names what we were *just* talking about: the disk-space result read last ("what
  // were we just talking about"). A recap of only the earlier Tokyo/France questions, or of
  // nothing, is the oddity; naming more topics is fine.
  const recap = norm(text(a.filter((f) => f.at >= m.last[0])));
  if (!/disk|space|storage|gigabyte|\bgb\b/.test(recap)) out.push({ kind: "recapMissesLatest", note: recap });
  return out;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  let n = 0, total = 0;
  const kinds = {};
  for (const file of process.argv.slice(2))
    for (const r of JSON.parse(readFileSync(file, "utf8")).runs) {
      const o = oddities(r);
      n++; total += o.length;
      for (const x of o) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
      console.log(`${n} ${r.verdict?.pass ? "PASS" : "FAIL"} oddities=${o.length} ${o.map((x) => `[${x.kind}] ${x.note}`).join(" | ")}`);
    }
  console.log(`ODDITIES ${total} in ${n} runs ${JSON.stringify(kinds)}`);
}
