// Voice jobs run on the main Hermes profile through its API server Runs API
// (docs: hermes-agent website/docs/user-guide/features/api-server.md, "Runs API").
// Hermes owns execution and concurrency; this app owns job state and delivery.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workerInstructions } from "./policy.js";
import { getLogger } from "../core/logger.js";
const logger = await getLogger("live.worker");

const active = ["queued", "running", "awaiting_permission"];
const terminal = { "run.completed": "completed", "run.failed": "failed", "run.cancelled": "cancelled", "run.interrupted": "interrupted" };
// Plain words only: raw Hermes error text is logged, never spoken.
export const reasons = {
  capacity: "I'm at capacity: Hermes is already running as many tasks as it allows, so this one did not start. Ask again when one finishes.",
  interrupted: "Hermes restarted during this task, so it stopped part way. It was not run again.",
  unreachable: "Hermes could not be reached, so this task did not start.",
  lost: "Hermes was unreachable for too long, so this task's outcome is unknown. It was not run again.",
  rejected: "Hermes would not start this task.",
  failed: "Hermes could not finish this task.",
  cancelled: "Stopped at your request. Actions already completed are not undone.",
};
const choiceNames = { once: "Allow once", session: "Allow for this session", always: "Always allow", deny: "Deny" };

/** Read only API_SERVER_KEY from the Hermes env file; the rest of that file stays out of this process. */
export function hermesKey(path = resolve(process.env.HOME, ".hermes/.env")) {
  if (process.env.HERMES_API_KEY) return process.env.HERMES_API_KEY;
  try {
    const line = readFileSync(path, "utf8").split("\n").find((l) => /^\s*API_SERVER_KEY\s*=/.test(l));
    return line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}

export class VoiceWorker {
  constructor({
    store,
    onUpdate,
    baseUrl = process.env.HERMES_API_URL || "http://10.69.3.175:8642",
    key = hermesKey(),
    fetch = globalThis.fetch,
    recall = async () => "",
    retryMs = 3000,
    unreachableMs = 10 * 60000,
    idleMs = 90000,
  }) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.key = key;
    this.fetch = fetch;
    this.recall = recall;
    this.retryMs = retryMs;
    this.unreachableMs = unreachableMs;
    this.idleMs = idleMs;
    this.following = new Map();
    this.permissions = new Map();
  }
  async request(path, { method = "GET", body, headers = {}, timeout = 15000, signal } = {}) {
    return this.fetch(this.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal || AbortSignal.timeout(timeout),
    });
  }
  /** Hermes liveness exactly as its docs define it: GET /health returns {"status":"ok"}. */
  async health(timeout = 2500) {
    try {
      const r = await this.fetch(this.baseUrl + "/health", { signal: AbortSignal.timeout(timeout) });
      const body = r.ok ? await r.json() : null;
      return body?.status === "ok" ? { ok: true } : { ok: false, error: `Hermes health returned ${r.status}${body?.status ? ` (${body.status})` : ""}.` };
    } catch (err) {
      return { ok: false, error: `Hermes is not answering (${err.name === "TimeoutError" ? "timeout" : err.cause?.code || err.message}).` };
    }
  }
  update(id, state, fields) {
    const job = this.store.updateJob(id, state, fields);
    this.onUpdate(job);
    return job;
  }
  /** Settle once; a cancelled or already-final job is never overwritten. */
  settle(id, state, fields = {}) {
    if (!active.includes(this.store.job(id)?.state)) return;
    for (const [key, p] of this.permissions) if (p.job === id) this.permissions.delete(key);
    this.update(id, state, fields);
  }
  /** Start every queued job side by side; Hermes enforces its own concurrency cap. */
  kick() {
    let job;
    const started = [];
    while ((job = this.store.nextJob())) {
      this.update(job.id, "running");
      started.push(this.track(job.id, this.start(job)));
    }
    return Promise.all(started);
  }
  /** Reattach to Hermes runs that were in flight when this service last stopped. */
  resume() {
    return Promise.all(
      this.store.activeRuns().filter((j) => !this.following.has(j.id)).map((j) => this.track(j.id, this.follow(j))),
    );
  }
  track(id, promise) {
    const p = promise
      .catch((err) => {
        logger.warn("Background work ended", { id, error: err.message });
        this.settle(id, "failed", { error: reasons.failed });
      })
      .finally(() => this.following.delete(id));
    this.following.set(id, p);
    return p;
  }
  /** One Hermes session per voice conversation; a job beside a live one gets its own lane, since one session runs one turn at a time. */
  sessionFor(job) {
    const main = `voice-${job.conversation}`;
    return this.store.busySessions(job.conversation).includes(main) ? `${main}-${job.id.slice(0, 8)}` : main;
  }
  async start(job) {
    const session = this.sessionFor(job);
    const context = this.store.cache(`session-context:${job.conversation}:${job.session}`)?.value || {};
    // Fresh memory for this request, so Hermes answers personal questions in one step
    // from the newest memories instead of an older answer in its session.
    const memory = await this.recall(job.request.split("\n").slice(-3).join("\n"));
    const body = {
      input: job.request,
      instructions: workerInstructions(this.store.jobs(job.conversation), context, memory),
      session_id: session,
    };
    // Reserve the lane before the POST so a concurrent job sees it as busy.
    this.store.setRun(job.id, null, session);
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await this.request("/v1/runs", {
          method: "POST",
          body,
          // Same key and body make a retry return the original run (Runs API idempotency).
          headers: { "Idempotency-Key": job.id, "X-Hermes-Session-Key": `voice:${job.conversation}` },
        });
        break;
      } catch (err) {
        if (attempt >= 2) {
          logger.warn("Hermes run not started", { id: job.id, error: err.message });
          return this.settle(job.id, "failed", { error: reasons.unreachable });
        }
        await sleep(this.retryMs);
      }
    }
    if (r.status === 429) {
      logger.warn("Hermes at capacity", { id: job.id });
      return this.settle(job.id, "failed", { error: reasons.capacity });
    }
    const started = await r.json().catch(() => ({}));
    if (!r.ok || !started.run_id) {
      logger.warn("Hermes run rejected", { id: job.id, status: r.status, error: started.error?.message });
      return this.settle(job.id, "failed", { error: reasons.rejected });
    }
    this.onUpdate(this.store.setRun(job.id, started.run_id, session));
    logger.info("Hermes run started", { id: job.id, run: started.run_id, session });
    // A cancel that landed before the run id existed still has to reach Hermes.
    if (this.store.job(job.id).state === "cancelled") await this.stopRun(started.run_id);
    return this.follow(this.store.job(job.id));
  }
  /** Follow run events; on any break, poll status until Hermes answers, then resume the stream. */
  async follow(job) {
    let seq = -1,
      lostSince = null;
    while (active.includes(this.store.job(job.id)?.state)) {
      try {
        seq = await this.events(job, seq);
        lostSince = null;
      } catch (err) {
        logger.info("Hermes event stream broke", { id: job.id, error: err.message });
      }
      if (!active.includes(this.store.job(job.id)?.state)) return;
      const status = await this.status(job.run_id);
      if (status === null) {
        lostSince ??= Date.now();
        if (Date.now() - lostSince > this.unreachableMs) return this.settle(job.id, "interrupted", { error: reasons.lost });
        await sleep(this.retryMs);
        continue;
      }
      lostSince = null;
      if (status === "missing") return this.settle(job.id, "interrupted", { error: reasons.interrupted });
      if (this.finish(job, status)) return;
      if (status.status === "waiting_for_approval" && status.approval) this.approval(job, status.approval);
      await sleep(this.retryMs);
    }
  }
  /** Poll GET /v1/runs/{id}: the run object, "missing" for an unknown run, null when Hermes is unreachable. */
  async status(run) {
    try {
      const r = await this.request(`/v1/runs/${encodeURIComponent(run)}`, { timeout: 5000 });
      if (r.status === 404) return "missing";
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }
  finish(job, run) {
    const state = { completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "interrupted" }[run.status];
    if (!state) return false;
    if (state === "completed" && !String(run.output || "").trim()) {
      this.settle(job.id, "failed", { error: reasons.failed });
      return true;
    }
    if (state !== "completed") logger.warn("Hermes run ended", { id: job.id, run: job.run_id, status: run.status, error: run.error });
    this.settle(job.id, state, state === "completed" ? { result: String(run.output).trim() } : { error: reasons[state] });
    return true;
  }
  async events(job, lastSeq) {
    const abort = new AbortController();
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new Error("No Hermes events or keepalive.")), this.idleMs);
    };
    touch();
    try {
      const r = await this.request(`/v1/runs/${encodeURIComponent(job.run_id)}/events?last_seq=${lastSeq}`, { signal: abort.signal });
      if (!r.ok) throw new Error(`Hermes events returned ${r.status}.`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of r.body) {
        touch();
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (Number.isInteger(event.seq)) lastSeq = event.seq;
          this.event(job, event);
        }
      }
      return lastSeq;
    } finally {
      clearTimeout(idle);
      abort.abort();
    }
  }
  event(job, event) {
    if (event.event === "approval.request") this.approval(job, event);
    else if (event.event === "approval.responded" && this.store.job(job.id).state === "awaiting_permission") this.update(job.id, "running");
    else if (terminal[event.event])
      this.finish(job, { status: terminal[event.event], output: event.output, error: event.error });
  }
  approval(job, event) {
    if (!active.includes(this.store.job(job.id)?.state)) return;
    const id = String(event.request_id || job.run_id);
    if (this.permissions.has(id)) return;
    this.permissions.set(id, {
      id,
      job: job.id,
      requestId: event.request_id || null,
      toolCall: { title: String(event.description || event.command || "Hermes needs your approval").slice(0, 300) },
      options: (event.choices || ["once", "deny"]).map((c) => ({ optionId: c, name: choiceNames[c] || c })),
    });
    this.update(job.id, "awaiting_permission");
  }
  async answer(jobId, id, optionId) {
    const p = this.permissions.get(String(id));
    if (!p || p.job !== jobId) throw new Error("That permission request is no longer active.");
    if (!p.options?.some((o) => o.optionId === optionId)) throw new Error("Invalid permission choice.");
    const run = this.store.job(jobId).run_id;
    const r = await this.request(`/v1/runs/${encodeURIComponent(run)}/approval`, {
      method: "POST",
      body: { choice: optionId, ...(p.requestId ? { request_id: p.requestId } : {}) },
    });
    if (!r.ok) throw Object.assign(new Error("Hermes did not accept that approval."), { status: 409 });
    this.permissions.delete(String(id));
    this.update(jobId, "running");
  }
  async stopRun(run) {
    try {
      await this.request(`/v1/runs/${encodeURIComponent(run)}/stop`, { method: "POST", body: {}, timeout: 5000 });
    } catch (err) {
      logger.warn("Hermes stop not confirmed", { run, error: err.message });
    }
  }
  cancel(job) {
    if (!active.includes(job.state)) return job;
    for (const [key, p] of this.permissions) if (p.job === job.id) this.permissions.delete(key);
    const updated = this.store.updateJob(job.id, "cancelled", { error: reasons.cancelled });
    if (job.run_id) void this.stopRun(job.run_id);
    this.onUpdate(updated);
    return updated;
  }
  stop() {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
