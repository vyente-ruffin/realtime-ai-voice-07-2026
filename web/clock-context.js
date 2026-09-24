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
  constructor(append, accepted = () => {}, snapshot = clockSnapshot) {
    super(append, accepted);
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
