// Keep the voice in English. The session instructions carry the rule; when the live output
// transcript shows another script (or undecodable text, which came first both times), the app sends
// one short trusted instruction. Seen live (Oct 16): garbled output, then a question and a Hermes
// result read aloud in Korean. MS Learn, "Use GPT-Live for real-time voice", "Add context during
// the conversation": session.instructions.append adds "trusted application instructions that
// change behavior or speech"; "What is GPT-Live": gpt-live-1 is multilingual.
export const ENGLISH_TEXT =
  "Speak only English from now on, including when you read a result. Do not repeat what you just said in another language.";
// Any letter outside the Latin script (Hangul, Armenian, Bengali… all seen live), and U+FFFD.
const OTHER_SCRIPT = /(?=\p{L})\P{Script=Latin}|\uFFFD/u;
// The user asked for another language: their choice wins.
const ASKED = /\b(?:in|speak|say it in|translate (?:it |that )?(?:in)?to)\s+(?:korean|japanese|chinese|mandarin|cantonese|spanish|french|german|italian|portuguese|russian|arabic|hindi|hebrew|greek|thai|vietnamese|other language|another language)\b/i;
export const NUDGE_GAP_MS = 10000;
/** Text in another script, or undecodable. */
export const notEnglish = (text) => OTHER_SCRIPT.test(String(text || ""));

export class LanguageGuard {
  constructor() {
    this.userChose = false;
    this.sentAt = -Infinity;
  }
  userSpeech(text) {
    if (ASKED.test(text || "") || OTHER_SCRIPT.test(text || "")) this.userChose = true;
  }
  /** An output transcript delta; returns the instruction to send now, or null. */
  assistantSpeech(text, now) {
    if (this.userChose || !OTHER_SCRIPT.test(text || "") || now - this.sentAt < NUDGE_GAP_MS) return null;
    this.sentAt = now;
    return ENGLISH_TEXT;
  }
}
