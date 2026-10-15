// The app owns result delivery: a finished job is not proof the user heard it,
// and interrupting speech does not cancel work (Microsoft Learn, "What is
// GPT-Live", "Speech and task work run independently"). This decides when a
// finished result may be spoken; it never sends anything itself.
export const PAUSE_MS = 2000;
// Any overlap of user and assistant speech holds delivery this long (transcript
// times are coarse and may arrive in either order, so overlap is checked both ways).
export const OVERLAP_HOLD_MS = 12000;
const FINAL = ["completed", "failed", "cancelled", "interrupted"];
const STOP = /\b(stop|quiet|shut up|hush|silence|enough)\b/i;
// Consent is a short reply that starts with an affirmative, judged on the whole turn.
const YES = /^\W*(yes|yeah|yep|yup|sure|okay|ok|go ahead|please do|tell me|let'?s hear)\b/i;
const NO = /\b(no|nope|not now|later|skip|don'?t)\b/i;
const CONSENT_SETTLE_MS = 1200;
const COUNTS = ["", "One thing", "Two things", "Three things", "Four things", "Five things"];

// Fix 7: the one line allowed unprompted after a dropped call that cut an answer off.
export const CUTOFF_LINE = "We got cut off. Want me to finish what I was saying?";

export function waitingLine(count) {
  return `${COUNTS[count] || "A few things"} finished while you were away. Want ${count === 1 ? "it" : "them"}?`;
}

export class DeliveryPolicy {
  constructor() {
    this.startCall();
  }
  /** A call spans every reconnect between pressing Start and End. */
  startCall() {
    this.sessions = new Set();
    this.asked = new Set(); // earlier-call jobs already covered by a waiting line
    this.approved = new Set(); // earlier-call jobs the user said yes to
    this.awaitingConsent = false;
    this.question = null; // what the pending yes/no answers: "waiting" or "cutoff"
    this.cutoff = null; // Fix 7: { job, at, asked, finish } after a drop cut an answer off
    this.cutOffYesAt = -Infinity; // when the user said yes to finishing it
    this.consentParts = []; // user speech after the waiting line: [start_ms, end_ms, text]
    this.lineEndMs = 0; // where the waiting line ended on the session clock
    this.lastUserAt = 0;
    this.lastAssistantAt = 0;
    this.spoken = []; // assistant [start_ms, end_ms] in the current session's audio clock
    this.heardSpans = []; // user [start_ms, end_ms], same clock
    this.holdUntil = 0;
    this.turn = { text: "", at: 0 };
    this.locked = false;
    this.lockStage = null; // "request" -> waiting for a new request; "answer" -> for its answer
    this.pushedAt = 0;
    this.activitySincePush = true;
  }
  joinSession(id) {
    this.sessions.add(id);
    this.spoken = []; // provider audio clocks restart per session
    this.heardSpans = [];
  }
  /** Fix 7: the connection dropped mid-answer. `job` is the result being read, or null when the
   * cut-off answer was the model's own. Offer to finish it once, at the first pause after reconnect. */
  cutOff(job, now) {
    this.cutoff = { job: job || null, at: now, asked: false, finish: false };
    this.activitySincePush = true;
  }
  /** Fix 7: a handoff made by the user's yes to the cut-off offer is not new work: the app already
   * has the answer. True while that yes is being said and for 10 s after it settles. */
  cutOffReply(now) {
    if (this.awaitingConsent && this.question === "cutoff") {
      const text = this.consentParts.map((part) => part[2]).join("").trim();
      return YES.test(text) && !NO.test(text) && text.split(/\s+/).length <= 6;
    }
    return now - this.cutOffYesAt < 10000;
  }
  fromThisCall(job) {
    return this.sessions.has(job.session);
  }
  /** Microphone energy: blocks a pause but, unlike words, is not a new turn. */
  heard(now) {
    this.lastUserAt = Math.max(this.lastUserAt, now);
  }
  userActive(now) {
    this.heard(now);
    this.activitySincePush = true;
  }
  assistantActive(now) {
    this.lastAssistantAt = Math.max(this.lastAssistantAt, now);
    this.activitySincePush = true;
  }
  assistantSpeech(event, now) {
    this.assistantActive(now);
    if (event.end_ms > event.start_ms) {
      this.spoken = [...this.spoken.slice(-199), [event.start_ms, event.end_ms]];
      if (overlaps(this.heardSpans, event)) this.holdUntil = now + OVERLAP_HOLD_MS;
      if (this.awaitingConsent && !this.consentParts.length) this.lineEndMs = Math.max(this.lineEndMs, event.end_ms);
    }
    // A spoken answer after the new request reopens delivery (after its pause).
    if (this.locked && this.lockStage === "answer") {
      this.locked = false;
      this.lockStage = null;
    }
    this.turn = { text: "", at: 0 };
  }
  /** Returns "interrupt", "consent" or null so callers can record what happened. */
  userSpeech(event, now) {
    this.userActive(now);
    if (event.end_ms > event.start_ms) {
      this.heardSpans = [...this.heardSpans.slice(-199), [event.start_ms, event.end_ms]];
      if (overlaps(this.spoken, event)) this.holdUntil = now + OVERLAP_HOLD_MS;
    }
    if (!this.turn.text || now - this.turn.at > 1800) this.turn = { text: "", at: now, startMs: event.start_ms };
    // Talking over the assistant: this turn began inside assistant speech that
    // had already started. A reply starts after the turn began, so it never counts,
    // even when its coarse timestamps overlap the turn's last words.
    const overlapped = this.spoken.some(([start, end]) => start <= this.turn.startMs && this.turn.startMs < end);
    this.turn.text += event.delta || "";
    this.turn.at = now;
    const text = this.turn.text;
    if (STOP.test(text)) {
      this.lock();
      this.awaitingConsent = false; // "stop" also declines a waiting-results question
      return "stop";
    }
    if (this.awaitingConsent) this.consentParts.push([event.start_ms, event.end_ms, event.delta || ""]);
    if (overlapped) {
      this.lock();
      return "interrupt";
    }
    if (this.locked && /\w{2,}/.test(text)) this.lockStage = "answer";
    return null;
  }
  /** An interruption keeps a pending waiting-results question: the user's reply still answers it. */
  lock() {
    this.locked = true;
    this.lockStage = "request";
  }
  paused(now, assistantSpeaking) {
    return !assistantSpeaking && now - this.lastUserAt >= PAUSE_MS && now - this.lastAssistantAt >= 600;
  }
  /** The reply to the waiting line, once the user has finished it. */
  settleConsent(now) {
    if (!this.awaitingConsent || now - this.lastUserAt < CONSENT_SETTLE_MS) return null;
    // Only speech that began after the line ended and overlaps no assistant speech is a
    // reply; stray transcript fragments during the line (seen live) are not.
    const text = this.consentParts
      .filter(([start, end]) => start >= this.lineEndMs && !overlaps(this.spoken, { start_ms: start, end_ms: end }))
      .map((part) => part[2])
      .join("")
      .trim();
    if (!/\w/.test(text)) return null;
    this.awaitingConsent = false;
    this.consentParts = [];
    const question = this.question;
    this.question = null;
    if (YES.test(text) && !NO.test(text) && text.split(/\s+/).length <= 6) {
      if (question === "cutoff" && this.cutoff) {
        this.cutOffYesAt = now;
        if (this.cutoff.job) this.approved.add(this.cutoff.job);
        else this.cutoff.finish = true;
      } else for (const id of this.asked) this.approved.add(id);
      return "consent";
    }
    if (question === "cutoff") this.cutoff = null; // declined: the result stays cut off, never pushed
    return "declined";
  }
  /** Decide the single next spoken step, or null. Call only while connected. */
  next(jobs, now, assistantSpeaking) {
    this.settled = this.settleConsent(now);
    const cut = this.cutoff;
    // Fix 7: after "yes" the cut-off answer goes at once, without waiting for a pause; a wait
    // left the voice room to retell it from memory (seen live).
    if (!this.locked && cut?.finish) return { kind: "finish" };
    if (!this.locked && cut?.job && this.approved.has(cut.job)) {
      const job = jobs.find((j) => j.id === cut.job && j.delivery === "cut_off");
      if (job) return { kind: "result", job, resume: true };
    }
    if (this.locked || !this.activitySincePush || now < this.holdUntil) return null;
    if (!this.paused(now, assistantSpeaking)) return null;
    if (cut && !cut.asked && !this.awaitingConsent && now - cut.at >= PAUSE_MS) return { kind: "cutoff", text: CUTOFF_LINE };
    const waiting = jobs
      .filter((j) => FINAL.includes(j.state) && (j.delivery || "available") === "available")
      .sort((a, b) => a.updated - b.updated);
    const ready = waiting.find((j) => this.fromThisCall(j) || this.approved.has(j.id));
    if (ready) return { kind: "result", job: ready };
    if (this.awaitingConsent) return null;
    const earlier = waiting.filter((j) => !this.fromThisCall(j) && !this.asked.has(j.id));
    if (earlier.length) return { kind: "waiting", jobs: earlier, text: waitingLine(earlier.length) };
    return null;
  }
  /** A step that never reached the model does not use up the pause. */
  unsent() {
    this.activitySincePush = true;
  }
  /** Record that a step was sent; the next one needs a fresh pause. */
  sent(step, now) {
    this.pushedAt = now;
    this.activitySincePush = false;
    if (step.kind === "cutoff") {
      this.cutoff.asked = true;
      this.question = "cutoff";
      this.awaitingConsent = true;
      this.consentParts = [];
      this.lineEndMs = 0;
    }
    if (step.kind === "finish" || step.resume) this.cutoff = null;
    if (step.kind === "waiting") {
      for (const j of step.jobs) this.asked.add(j.id);
      this.question = "waiting";
      this.awaitingConsent = true; // the user's next turn answers it
      this.consentParts = [];
      this.lineEndMs = 0;
    }
  }
}

function overlaps(spans, event) {
  return spans.some(([start, end]) => start < event.end_ms && event.start_ms < end);
}
