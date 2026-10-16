// Judge one normal-conversation call (scripts/live-e2e/convo.mjs, docs/evidence/conversation.md)
// from its state.sqlite fragments. Kept apart from the live script so tests/live can check the rules.
// marks: each utterance's [start, end] in wall-clock ms, as the harness played it. Fragments are
// placed by their `at` (the server's receipt time, same machine clock): the session audio clock
// (start_ms) ran about 5 s ahead of the wall clock over one call, so it can't be lined up with the
// utterances. The page flushes fragments every 700 ms, so `at` is at most ~0.75 s late: every
// "nothing after" check below is strict by that much.
import { spokenTimes, zoneTime, minutesOff } from "./clock-zones-judge.mjs";
import { notEnglish } from "../../web/language.js";

const text = (frags) => frags.map((f) => f.text).join("");
const between = (frags, role, from, to) => frags.filter((f) => f.role === role && f.at >= from && f.at < to);
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/** 38 -> "thirty[- ]eight", for a whole number under 100 (else a pattern that never matches). */
const spelled = (n) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 99) return "(?!)";
  return v < 20 ? ONES[v] : TENS[Math.floor(v / 10)] + (v % 10 ? `[\\s-]?${ONES[v % 10]}` : "");
};
const words = (s) => (String(s).match(/[\p{L}\p{N}']+/gu) || []).length;

export function judgeConvo({ frags, marks, result = "", deliveries = [], resultAt = null }) {
  const assistant = frags.filter((f) => f.role === "assistant");
  const checks = {};
  // 1. Silent on connect: nothing before the user's first words.
  const early = assistant.filter((f) => f.at < marks.hi[0]);
  checks.silentOnConnect = { pass: early.length === 0, said: text(early) };
  // 2. "How's it going" gets an answer, with no time in it.
  const hi = text(between(frags, "assistant", marks.hi[0], marks.p1[0]));
  const hiTimes = spokenTimes(hi);
  checks.hiNoTime = { pass: words(hi) > 0 && hiTimes.length === 0 && !/\d{1,2}:\d{2}/.test(hi), said: hi, times: hiTimes.map((t) => t.said) };
  // 3. No speech in the mid-sentence pause (end of "uh" to the start of "what time").
  // A filler begun in the pause is received up to ~1 s later, so the window runs 1 s into "what time".
  const pause = between(frags, "assistant", marks.p1[1], marks.p2[0] + 1000);
  checks.silentInPause = { pass: pause.length === 0, said: text(pause) };
  // 4. Tokyo time matches Intl within 1 minute, at the answer's first fragment.
  const tokyoFrags = between(frags, "assistant", marks.p2[0], marks.france[0]);
  const tokyoSaid = spokenTimes(text(tokyoFrags))[0] || null;
  const expected = tokyoFrags.length ? zoneTime("Asia/Tokyo", tokyoFrags[0].at) : null;
  const off = tokyoSaid && expected ? minutesOff(tokyoSaid, expected.minutes) : null;
  checks.tokyoTime = { pass: off !== null && off <= 1, said: text(tokyoFrags), spoken: tokyoSaid?.said ?? null, expected: expected?.text ?? null, minutesOff: off };
  // 6 (first, to bound 5). The result read once, in English: its first number, counted up to the
  // last question ("what were we just talking about" may fairly recap it), and no other script.
  // The result's amount with its unit ("38 GB" read as "38 gigabytes" too), not a bare number: a
  // bare "38" also matched the times "1:38" and "5:38".
  const key = String(result).match(/\d+(?:\.\d+)?/)?.[0] || null;
  const all = text(assistant.filter((f) => f.at < marks.last[0]));
  const keyRe = key ? new RegExp(`(?:(?<![\\d:])${key.replace(".", "\\.")}|\\b${spelled(key)})[\\s-]*(?:GB|GiB|gigabytes?|gibibytes?|gigs?|G\\b)`, "gi") : null;
  const reads = keyRe ? (all.match(keyRe) || []).length : 0;
  const firstRead = keyRe ? assistant.find((f, i) => { keyRe.lastIndex = 0; return keyRe.test(text(assistant.slice(Math.max(0, i - 3), i + 1))); }) : null;
  const other = assistant.filter((f) => notEnglish(f.text));
  checks.resultOnceEnglish = { pass: reads === 1 && other.length === 0, key, reads, notEnglish: text(other), deliveries: deliveries.map((d) => d.state) };
  // 5. France answered "Paris", nothing made up: from the question to the result's injection
  // (the app's delivery.injected audit row; else its first fragment with the result's number) or "Stop".
  const readAt = resultAt ?? (firstRead && firstRead.at > marks.france[0] ? firstRead.at : Infinity);
  const franceEnd = Math.min(marks.stop[0], readAt > marks.france[0] ? readAt : Infinity);
  const france = text(between(frags, "assistant", marks.france[0], franceEnd));
  const madeUp = /capital of (?!france)|canberra|australia|\?\s*\S/i.test(france.replace(/paris/gi, ""));
  checks.franceParis = { pass: /paris/i.test(france) && !madeUp && words(france) <= 20, said: france };
  // 7. Nothing spoken more than 1 s after "Stop" ends, until the next question starts.
  const after = between(frags, "assistant", marks.stop[1] + 1000, marks.last[0]);
  checks.silentAfterStop = { pass: after.length === 0, said: text(after) };
  // 8. The question after stop is answered.
  const answer = text(assistant.filter((f) => f.at >= marks.last[0]));
  checks.afterStopAnswered = { pass: words(answer) > 0, said: answer };
  return { pass: Object.values(checks).every((c) => c.pass), checks };
}
