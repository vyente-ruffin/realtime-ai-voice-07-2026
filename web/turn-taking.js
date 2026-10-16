// Fix 5: let V finish talking. GPT-Live has no turn-detection setting; the live model "decides
// when to respond" (MS Learn, "What is GPT-Live", "How GPT-Live works"), and
// session.instructions.append adds "trusted application instructions that change behavior or
// speech" mid-call (MS Learn, "Use GPT-Live for real-time voice", "Add context during the
// conversation"). This decides when the app sends a short trusted "let them finish" instruction,
// from the live input transcript; it never sends anything itself.
// Seen live: the voice filled V's pause after "So can you check, uh" with "Go ahead, what do you
// want me to check?", so a trailing filler gets a short "stay silent" instruction. Nothing is sent
// while the user is talking: an instruction sent at the first words of every turn (Fix 5 Part 3)
// made the voice miss the next ~0.5 s of speech. "So can you check, uh" was transcribed whole
// before it and lost "check" in almost every 5a run after it; "Hey Jarvis, how's it going?" became
// "Hey Jarvis, how's" and went unanswered (Oct 16). The let-them-finish rule is in the session
// instructions; a missed reply gets the watchdog below.
// A turn ends when the voice speaks. A pause alone never ends it: 1.5 s of silence plus transcript
// lag passed a 1.8 s gap, the instruction went out again mid-sentence and the voice never answered
// (seen live). Only a long silence starts a new turn without the voice speaking.
export const TURN_GAP_MS = 10000;
// A trailing filler: the user has paused mid-sentence. (Joining words such as "in" also fired at
// "what time it is in", just before "Tokyo", and the voice then hesitated or handed it off.)
const FILLER = /(?:\b(?:uh+|uhm+|um+|ah+|er+|erm|hmm+)|\.\.\.|…)[\s,.]*$/i;

export const UNFINISHED_TEXT = "The user paused mid-sentence. Stay silent and wait for the rest of their words.";
// A finished question the voice let pass: no reply 2.5 s after the user's last words. Seen live
// (Oct 16): "Hey Jarvis, how's it going?" and the question after a stop went unanswered for 25 s.
// GPT-Live has no "respond now" event; the model "decides when to respond" (MS Learn, "What is
// GPT-Live"), and session.instructions.append is the documented way to change speech, so the app
// sends one short trusted instruction, once per turn. Never for a stop, an unfinished sentence
// ("uh"), a turn handed to the backend, or words with no question in them. It also answers the
// question after a stop: "say nothing until the user speaks again" kept the voice silent through
// it (2 of 2 calls, Oct 16).
export const REPLY_WAIT_MS = 2500;
export const REPLY_TEXT = "The user has finished and is waiting for your reply: answer them now, briefly.";
const QUESTION = /\?|\b(?:what|how|who|where|when|why|which|can you|could you)\b/i;

export function unfinished(text) {
  return FILLER.test(String(text || "").trim());
}

export class TurnTaking {
  constructor() {
    this.turn = null; // { text, at, startedAt, unfinishedSent, nudged, delegated }
  }
  /** The assistant spoke: the user's next words are a new turn. */
  assistantSpeech() {
    this.turn = null;
  }
  /** "Stop" ends the user's turn too: the voice stays silent after it, so the next question is a
   * turn of its own (its reply watchdog included), not more of the stop. */
  endTurn() {
    this.turn = null;
  }
  /** The voice handed this turn to the backend: its reply is the handoff, not speech. */
  delegated() {
    if (this.turn) this.turn.delegated = true;
  }
  /** Called REPLY_WAIT_MS after the user's last words: the nudge to send now, or null. */
  replyDue(now) {
    const t = this.turn;
    if (!t || t.nudged || t.delegated || t.startedAt === null || now - t.at < REPLY_WAIT_MS) return null;
    if (unfinished(t.text) || !QUESTION.test(t.text)) return null;
    t.nudged = true;
    return REPLY_TEXT;
  }
  /** A user transcript delta. Returns the instruction to send now, or null. */
  userSpeech(event, now) {
    if (!this.turn || now - this.turn.at > TURN_GAP_MS) this.turn = { text: "", at: now, startedAt: null, unfinishedSent: false };
    this.turn.text += event.delta || "";
    this.turn.at = now;
    if (!/\w/.test(this.turn.text)) return null;
    if (this.turn.startedAt === null) {
      this.turn.startedAt = now;
      return null;
    }
    // Once per turn, and not on the turn's first words.
    if (!this.turn.unfinishedSent && now - this.turn.startedAt >= 600 && unfinished(this.turn.text)) {
      this.turn.unfinishedSent = true;
      return { kind: "unfinished", text: UNFINISHED_TEXT };
    }
    return null;
  }
}
