// Fix 7 scoring rules (docs/VOICE-FIX-PLAN.md, "handle a dropped call cleanly"), kept pure so
// tests/live/reconnect.test.mjs pins them. Inputs are rows from state.sqlite `fragments`.
export const OFFER = /cut off/i;
const STOPWORDS = new Set(["about", "after", "again", "because", "before", "every", "their", "there", "these", "which", "while", "would", "could", "should", "where", "other", "those", "being", "until"]);

/** Distinctive words of a text: five letters or more, lower case, no common function words. */
export function contentWords(text) {
  return [...new Set((text.toLowerCase().match(/[a-z']{5,}/g) || []).filter((w) => !STOPWORDS.has(w)))];
}

/** Assistant fragments joined into turns (same rule as harness turns()). */
function assistantTurns(fragments) {
  const out = [];
  for (const f of fragments.filter((x) => x.role === "assistant")) {
    const last = out.at(-1);
    if (last && f.start_ms - last.end_ms < 1800) {
      last.text += f.text;
      last.end_ms = f.end_ms;
    } else out.push({ text: f.text, at: f.at, start_ms: f.start_ms, end_ms: f.end_ms });
  }
  return out;
}

/** 7a: before the user speaks, the new session says nothing or only the single cut-off offer,
 * and none of the cut-off answer's distinctive words (a resumed sentence) appear. */
export function verdict7a({ fragments, until, answer }) {
  const before = fragments.filter((f) => f.role === "assistant" && f.at < until);
  const turns = assistantTurns(before);
  const said = turns.map((t) => t.text).join(" ");
  const offerWords = new Set(contentWords("We got cut off. Want me to finish what I was saying?"));
  const resumed = contentWords(answer).filter((w) => !offerWords.has(w) && said.toLowerCase().includes(w));
  const first = turns[0]?.text.trim() || "";
  const silent = turns.length === 0;
  // The single offer: one turn, asking once (the voice's own extra offer before it is not single).
  const offerOnly = turns.length === 1 && (first.match(/cut off/gi) || []).length === 1 && (first.match(/finish/gi) || []).length === 1;
  return { pass: (silent || offerOnly) && resumed.length === 0, silent, offerOnly, first, turns: turns.length, resumed };
}

/** 7b: after "yes, finish" the result is spoken in full: its key word and at least 80% of its
 * distinctive words appear in the assistant speech, and the app re-delivered the job after the yes.
 * Before that re-delivery the voice says at most a short acknowledgment (`early`: speech received
 * between the yes and the injection), never its own made-up version. `repeats` counts how often the
 * result's last sentence was said: more than once is a double read. `rerunJobs` counts jobs created in
 * the reconnected session (the finish handed to the backend again); it must be 0. */
export function verdict7b({ spoken, result, key, delivery, yesAt, session, early = "", rerunJobs = 0 }) {
  const earlyWords = (early.match(/[A-Za-z']+/g) || []).length;
  const last = contentWords(result.split(/(?<=[.!?])\s+/).filter(Boolean).at(-1) || "");
  const sentences = spoken.toLowerCase().split(/(?<=[.!?])\s+/);
  const repeats = last.length ? sentences.filter((x) => last.filter((w) => x.includes(w)).length >= Math.ceil(last.length * 0.8)).length : 0;
  const words = contentWords(result);
  const lower = spoken.toLowerCase();
  const heard = words.filter((w) => lower.includes(w));
  const coverage = words.length ? heard.length / words.length : 0;
  const redelivered = Boolean(delivery && delivery.session === session && delivery.state === "injected" && delivery.updated > yesAt);
  const hasKey = Boolean(key) && lower.includes(key.toLowerCase());
  return { pass: hasKey && coverage >= 0.8 && redelivered && earlyWords <= 3 && repeats <= 1 && rerunJobs === 0, coverage: Math.round(coverage * 100) / 100, hasKey, redelivered, earlyWords, repeats, rerunJobs, missing: words.filter((w) => !lower.includes(w)) };
}
