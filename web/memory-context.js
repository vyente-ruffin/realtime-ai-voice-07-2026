// Quiet per-section updates. An acknowledgment proves injection, not spoken use.
export class MemoryContext {
  constructor(append, accepted = () => {}) {
    this.append = append;
    this.accepted = accepted;
    this.reset();
  }
  reset(models = []) {
    this.applied = new Map(models.map((model) => [model.id, model.revision]));
    this.pending = new Map();
    this.inflight = new Map();
  }
  receive(models) {
    for (const model of models) this.pending.set(model.id, model);
    this.flush();
  }
  flush() {
    for (const [id, model] of this.pending) {
      if (this.inflight.has(id)) continue;
      if (this.applied.get(id) === model.revision) {
        this.pending.delete(id);
        continue;
      }
      const events = this.append("session.thinking.append", model.context);
      if (events.length) this.inflight.set(id, { model, remaining: new Set(events) });
    }
  }
  acknowledge(eventId) {
    for (const [id, update] of this.inflight) {
      if (!update.remaining.delete(eventId) || update.remaining.size) continue;
      this.applied.set(id, update.model.revision);
      this.inflight.delete(id);
      this.accepted({ id, revision: update.model.revision });
      this.flush();
      break;
    }
  }
  reject(eventId) {
    for (const [id, update] of this.inflight)
      if (update.remaining.has(eventId)) this.inflight.delete(id);
    // Retry on the next server snapshot, not in a loop on provider failure.
  }
}
