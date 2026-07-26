// Verbatim-fidelity scorer for M1.T2 (guards [C5]).
// Usage: node jaccard.mjs "expected text" "actual transcript"
// Prints JSON {jaccard, lenRatio}; exits 0 if jaccard >= 0.9 AND lenRatio <= 1.25.

function tokens(s) {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean)
  );
}

const [, , expected, actual] = process.argv;
if (expected === undefined || actual === undefined) {
  process.stderr.write("usage: jaccard.mjs <expected> <actual>\n");
  process.exit(2);
}

const a = tokens(expected);
const b = tokens(actual);
const inter = [...a].filter((t) => b.has(t)).length;
const union = new Set([...a, ...b]).size;
const jaccard = union === 0 ? 0 : inter / union;
const lenRatio = expected.length === 0 ? 99 : actual.length / expected.length;

process.stdout.write(JSON.stringify({ jaccard: +jaccard.toFixed(3), lenRatio: +lenRatio.toFixed(3) }) + "\n");
process.exit(jaccard >= 0.9 && lenRatio <= 1.25 ? 0 : 1);
