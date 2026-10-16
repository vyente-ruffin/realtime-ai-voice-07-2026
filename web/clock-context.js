// Browser clock updates use the same acknowledged quiet-context path as memory.
import { MemoryContext } from "./memory-context.js";

export function clockSnapshot(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone, dateStyle: "full", timeStyle: "short",
  }).format(now);
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone, timeZoneName: "long",
  }).formatToParts(now).find(part => part.type === "timeZoneName").value;
  return {
    id: "browser-clock",
    revision: `${Math.floor(now.getTime() / 60000)}:${timeZone}`,
    context: `Current browser-local date and time: ${local}, ${zoneName}. Browser zone ID: ${timeZone}. Observed at ${now.toISOString()}. Replaces earlier clock snapshots. Minute precision. Quiet context; answer date/time questions directly from this clock without a Hermes lookup. Do not announce clock updates.`,
  };
}

export class ClockContext extends MemoryContext {
  constructor(append, accepted = () => {}, snapshot = clockSnapshot, options = {}) {
    super(append, accepted, options);
    this.snapshot = snapshot;
    this.timer = null;
  }
  start() {
    // Check locally each second; send only when the minute or zone changes.
    if (this.timer === null) this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }
  refresh() {
    if (this.timer === null) return;
    const snapshot = this.snapshot();
    const pending = this.inflight.get(snapshot.id);
    // A missing acknowledgment must not hold a later minute behind an old clock.
    if (pending && pending.model.revision !== snapshot.revision)
      this.inflight.delete(snapshot.id);
    this.receive([snapshot]);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.reset();
  }
}

// Fix 5 (Part 3): a plain date or time question, here or in another city. The speech policy says
// these come from the browser clock, never a handoff; when the voice hands one off anyway, the app
// answers that delegation from the clock (client delegation: the application performs the work and
// returns the result as context; MS Learn, "Delegate work in GPT-Live"). Seen live: "So can you
// check, uh, what time it is in Tokyo" handed to Hermes with "Let me add the offset." first.
const TIME_QUESTION = /\b(?:what(?:'s| is)?(?: the)? (?:time|date|day)|what time|time is it|time it is|today'?s date)\b/i;
const OTHER_WORK = /\b(?:remind|reminder|schedule|book|send|calendar|meeting|alarm|timer|appointment|flight|weather|open|close|until|since|ago|last time|next time)\b/i;
export function clockQuestion(text) {
  const s = String(text || "");
  return TIME_QUESTION.test(s) && !OTHER_WORK.test(s);
}
