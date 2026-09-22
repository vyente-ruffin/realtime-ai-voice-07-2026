import { AcpClient } from "../acp-client.js";
import { workerPrompt } from "./policy.js";
import { getLogger } from "../core/logger.js";
const logger = await getLogger("live.worker");
export class VoiceWorker {
  constructor({
    store,
    onUpdate,
    clientFactory = (options) => new AcpClient(options),
  }) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.clientFactory = clientFactory;
    this.client = null;
    this.current = null;
    this.running = false;
    this.permissions = new Map();
  }
  async ready() {
    if (this.readyPromise) return this.readyPromise;
    if (this.client?.isAlive()) return this.client;
    this.client = this.clientFactory({
      onPermission: (id, params) => this.permission({ id, ...params }),
    });
    this.readyPromise = this.client
      .start()
      .then(() => {
        this.conversation = null;
        return this.client;
      })
      .catch((error) => {
        this.client?.stop();
        this.client = null;
        throw error;
      })
      .finally(() => {
        this.readyPromise = null;
      });
    return this.readyPromise;
  }
  async warm() {
    if (this.warmPromise) return this.warmPromise;
    this.warmPromise = this.ready()
      .then(async (client) => {
        if (!client.sessionId) await client.newSession();
        return client;
      })
      .finally(() => {
        this.warmPromise = null;
      });
    return this.warmPromise;
  }
  permission(permission) {
    if (!this.current) return;
    this.permissions.set(String(permission.id), {
      ...permission,
      job: this.current.id,
    });
    const job = this.store.updateJob(this.current.id, "awaiting_permission");
    this.onUpdate(job);
  }
  answer(jobId, id, optionId) {
    const p = this.permissions.get(String(id));
    if (!p || p.job !== jobId)
      throw new Error("That permission request is no longer active.");
    if (!p.options?.some((o) => o.optionId === optionId))
      throw new Error("Invalid permission choice.");
    this.client.answerPermission(p.id, optionId);
    this.permissions.delete(String(id));
    this.onUpdate(this.store.updateJob(jobId, "running"));
  }
  async kick() {
    if (this.running) return;
    this.running = true;
    try {
      let job;
      while ((job = this.store.nextJob())) {
        this.current = job;
        this.onUpdate(this.store.updateJob(job.id, "running"));
        try {
          const client = await (this.warmPromise || this.ready());
          if (this.conversation !== job.conversation) {
            if (this.conversation !== null || !client.sessionId)
              await client.newSession();
            this.conversation = job.conversation;
          }
          const reply = await client.prompt(
            workerPrompt(job, [], this.store.jobs(job.conversation),
              this.store.cache(`session-context:${job.conversation}:${job.session}`)?.value || {}),
          );
          if (this.store.job(job.id).state === "cancelled") continue;
          if (/^\s*Error:/i.test(reply.text || ""))
            throw new Error(
              "Hermes returned an internal error; the task outcome is unverified.",
            );
          if (reply.stopReason !== "end_turn" || !reply.text?.trim())
            throw new Error(
              `Hermes ended without a result (${reply.stopReason || "unknown"}).`,
            );
          this.onUpdate(
            this.store.updateJob(job.id, "completed", {
              result: reply.text.trim(),
            }),
          );
        } catch (err) {
          if (this.store.job(job.id).state !== "cancelled")
            this.onUpdate(
              this.store.updateJob(job.id, "failed", { error: err.message }),
            );
          logger.warn("Background work ended", {
            id: job.id,
            error: err.message,
          });
          this.client?.stop();
          this.client = null;
        } finally {
          for (const [id, p] of this.permissions)
            if (p.job === job.id) this.permissions.delete(id);
          this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
  cancel(job) {
    if (!["queued", "running", "awaiting_permission"].includes(job.state))
      return job;
    const updated = this.store.updateJob(job.id, "cancelled", {
      error:
        "Stopped at your request. Actions already completed are not undone.",
    });
    if (this.current?.id === job.id) {
      this.client?.cancel();
    }
    this.onUpdate(updated);
    return updated;
  }
  stop() {
    this.client?.stop();
  }
}
