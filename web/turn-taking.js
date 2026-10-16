// Fix 5: let V finish talking. GPT-Live has no turn-detection setting; the live model "decides
// when to respond" (MS Learn, "What is GPT-Live", "How GPT-Live works"), and
// session.instructions.append adds "trusted application instructions that change behavior or
// speech" mid-call (MS Learn, "Use GPT-Live for real-time voice", "Add context during the
// conversation"). This decides when the app sends a short trusted "let them finish" instruction,
// from the live input transcript; it never sends anything itself.
// Seen live: the voice filled V's pause after "So can you check, uh" with "Go ahead, what do you
// want me to check?". The "uh" fragment arrived together with that reply, so the instruction goes
// at the first words of each turn (about 1 s before such a pause), and again on a trailing filler.
// A turn ends when the voice speaks. A pause alone never ends it: 1.5 s of silence plus transcript
// lag passed a 1.8 s gap, the instruction went out again mid-sentence and the voice never answered
// (seen live). Only a long silence starts a new turn without the voice speaking.
export const TURN_GAP_MS = 10000;
// A trailing filler: the user has paused mid-sentence. (Joining words such as "in" also fired at
// "what time it is in", just before "Tokyo", and the voice then hesitated or handed it off.)
const FILLER = /(?:\b(?:uh+|uhm+|um+|ah+|er+|erm|hmm+)|\.\.\.|…)[\s,.]*$/i;

// "When they finish, answer at once" made the voice preface its answer and hand a clock question to
// Hermes (seen live); without it the voice still handed "can you check… what time it is in Tokyo"
// off in 3 of 10 calls, so the instruction repeats the existing rule: answer what you can yourself.
export const START_TEXT =
  "The user is still speaking. Do not fill a pause or an \"uh\" with a reply, acknowledgment or question; wait silently for the rest of their words. Then answer yourself when you can, as usual: times come from the browser clock, not a handoff.";
export const UNFINISHED_TEXT = "The user paused mid-sentence. Stay silent and wait for the rest of their words.";

export function unfinished(text) {
  return FILLER.test(String(text || "").trim());
}

export class TurnTaking {
  constructor() {
    this.turn = null; // { text, at, startedAt, unfinishedSent }
  }
  /** The assistant spoke: the user's next words are a new turn. */
  assistantSpeech() {
    this.turn = null;
  }
  /** A user transcript delta. Returns the instruction to send now, or null. */
  userSpeech(event, now) {
    if (!this.turn || now - this.turn.at > TURN_GAP_MS) this.turn = { text: "", at: now, startedAt: null, unfinishedSent: false };
    this.turn.text += event.delta || "";
    this.turn.at = now;
    if (!/\w/.test(this.turn.text)) return null;
    if (this.turn.startedAt === null) {
      this.turn.startedAt = now;
      return { kind: "start", text: START_TEXT };
    }
    // Once per turn, and not in the same breath as the start instruction.
    if (!this.turn.unfinishedSent && now - this.turn.startedAt >= 600 && unfinished(this.turn.text)) {
      this.turn.unfinishedSent = true;
      return { kind: "unfinished", text: UNFINISHED_TEXT };
    }
    return null;
  }
}
