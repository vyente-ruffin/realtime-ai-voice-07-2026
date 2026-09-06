// Task-aware fillers.
//
// Pattern is Microsoft's `llm_interim_response` (Voice Live): a lightweight
// model writes context-aware bridging text instead of picking from a fixed
// list, and it fires when the work starts rather than on a stopwatch.
//   https://learn.microsoft.com/azure/ai-services/speech-service/how-to-voice-live-interim-response
// Voice Live's own `interim_response` setting is unavailable to us — that is a
// Voice Live feature and this front end speaks to the realtime API directly —
// so the same pattern is applied at the seam we already own: the gap between
// hearing the question and Hermes answering it.
//
// Latency contract: generation starts the moment the transcript arrives, in
// parallel with the brain. Nothing here is ever awaited on the answer path, so
// a slow or dead filler model cannot delay a reply. If the phrase is not ready
// (or is rejected) when the filler is due, the caller speaks a static line.

import { getLogger } from "./core/logger.js";

const logger = await getLogger("filler-llm");

const ENDPOINT = process.env.VOICE_FILLER_LLM_URL || "http://10.69.3.129:11434/api/chat";
// qwen3 over llama3.2:1b on the 10-question bench: 10/10 clean vs 4/10. The 1B
// model answers the question or refuses it ("There's a variety of accounts
// available", "I can't provide personal information") instead of stalling.
const MODEL = process.env.VOICE_FILLER_LLM_MODEL || "qwen3:latest";
// Budget, not a deadline: the answer never waits on this. It only bounds how
// long a wedged model may hold a socket.
const TIMEOUT_MS = Number(process.env.VOICE_FILLER_LLM_TIMEOUT_MS || 2500);

// Framed as text transformation, not as a question to answer. Asking a small
// model to "stall on this question" makes it answer or refuse; asking it to
// rewrite a sentence makes it rewrite the sentence.
const SYSTEM = [
  "You are a text transformer. Convert the INPUT sentence into a short",
  "'I am going to go look' phrase that reuses the input's nouns.",
  "You are not answering anything; you are only rephrasing.",
  "Output 4-7 words, one phrase, nothing else.",
].join(" ");

// Few-shot beats instructions for a small model: the shape of the answer is
// carried by the examples, not by prose it will not follow. The Teresa and log
// rows exist to pre-empt the two refusal classes seen on the bench.
const SHOTS = [
  ["How many accounts does it have?", "Let me pull up your accounts."],
  ["What projects am I working on?", "Checking your project list now."],
  ["Any chats going on in Hermes?", "One sec, looking at Hermes."],
  ["Who is Teresa?", "Let me look up Teresa."],
  ["Read me the last lines of the log.", "Pulling up the log now."],
  ["What time is it?", "Let me check the clock."],
  ["What do you know about the finance agent?", "Looking into the finance agent."],
];

// A filler that states a fact is worse than "hang on" — it invents an answer in
// V's ear before the real one arrives. Everything below is a hard reject, and a
// reject means the static list speaks instead.
const BANNED = [
  /\bthere (are|is|were|was)\b/i,      // "There are primary and secondary accounts."
  /\bi can'?t\b/i,                     // refusals
  /\bi (don'?t|do not) (know|have)\b/i,
  /\bsorry\b/i,
  /\b(you have|it has|we have)\b/i,    // states a fact about the answer
  /\b\d+\b/,                           // any number is a fact it cannot know
  /[?]/,                               // never ask the user a question
  /\b(as an ai|language model|assistant)\b/i,
];

// Generic non-answers ("I'm about to go look") carry no task information, so
// they fail the relevance bar even though they are harmless.
const VAGUE = [
  /^i'?m about to go look\.?$/i,
  /^(one sec|hang on|just a moment)\.?$/i,
  /^let me (check|look)\.?$/i,
];

/** Return the cleaned phrase, or null when it must not be spoken. */
export function validateFiller(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/<\/?think>/g, "").trim();
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  // One phrase only: a second sentence is where facts leak in.
  const firstBreak = text.search(/(?<=[.!])\s+\S/);
  if (firstBreak !== -1) text = text.slice(0, firstBreak + 1).trim();
  text = text.replace(/\.{2,}$/, ".");
  if (!text) return null;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 9) return null;
  if (BANNED.some((re) => re.test(text))) return null;
  if (VAGUE.some((re) => re.test(text))) return null;
  if (!/[.!]$/.test(text)) text += ".";
  return text;
}

async function callModel(question, signal) {
  const messages = [{ role: "system", content: SYSTEM }];
  for (const [u, a] of SHOTS) {
    messages.push({ role: "user", content: "INPUT: " + u }, { role: "assistant", content: a });
  }
  messages.push({ role: "user", content: "INPUT: " + question });

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      // qwen3 emits <think> blocks by default, which blow the token budget and
      // leave nothing for the phrase itself.
      think: false,
      options: { temperature: 0.3, num_predict: 16 },
      messages,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`filler model HTTP ${res.status}`);
  const data = await res.json();
  return data?.message?.content ?? "";
}

/**
 * Start generating a filler for `question`. Returns a handle whose `.get()`
 * yields the validated phrase or null. Never throws and never blocks the
 * answer path.
 */
export function startFiller(question) {
  const state = { text: null, ms: null, reason: "pending" };
  if (!question || !question.trim()) {
    state.reason = "no-transcript";
    return { get: () => null, state };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  const promise = callModel(question.trim(), controller.signal)
    .then((raw) => {
      const valid = validateFiller(raw);
      state.ms = Date.now() - started;
      if (valid) {
        state.text = valid;
        state.reason = "ok";
      } else {
        state.reason = "rejected";
        state.rejected = String(raw).slice(0, 120);
      }
    })
    .catch((err) => {
      state.ms = Date.now() - started;
      state.reason = err?.name === "AbortError" ? "timeout" : "error";
      state.error = String(err?.message || err).slice(0, 120);
      logger.debug("Task-aware filler unavailable", { reason: state.reason, error: state.error });
    })
    .finally(() => clearTimeout(timer));

  return {
    get: () => state.text,
    state,
    // Only for tests; production never awaits this.
    settled: () => promise,
    cancel: () => { clearTimeout(timer); controller.abort(); },
  };
}
