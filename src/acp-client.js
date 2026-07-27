// ACP client: one `hermes acp` stdio child per voice session.
// Protocol: newline-delimited JSON-RPC [A7]; initialize -> session/new ->
// session/prompt [A5][A2][A3]; replies stream as session/update chunks [A6];
// turn ends with a stopReason [A4]; session/cancel is a notification [A8].
// The ACP session_id is the stable public handle we persist [H3].
//
// Spawning a child touches nothing in the hermes install (plan Section 2).

import { spawn } from "node:child_process";
import { getLogger } from "./core/logger.js";

const logger = await getLogger("acp-client");

const INIT_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 120_000;
const PROMPT_TIMEOUT_MS = 300_000;
const DRAIN_MS = 800;   // let post-response chunks settle
const TAIL_MS = 1_500;  // chunks this soon after a reply are its tail, not news

// Tool-call kinds we consider read-class: safe to auto-approve because they
// cannot mutate state. Everything else requires spoken confirmation [A9].
const READ_KINDS = new Set(["read", "search", "fetch", "think"]);
const READ_TITLE = /^(read|list|search|show|view|get|find|grep|cat)\b/i;

export class AcpClient {
  constructor({ cwd = process.cwd(), onChunk = null, onPermission = null, onAnnouncement = null } = {}) {
    this.cwd = cwd;
    this.onChunk = onChunk;
    this.onPermission = onPermission;
    this.onAnnouncement = onAnnouncement;
    this.child = null;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.chunks = [];
    this.pendingPermissions = new Map();
    this.dead = false;
    this.inFlight = false;
    this.promptChain = Promise.resolve();
    this.lastPromptEndMs = 0;
    this.announceBuffer = [];
    this.announceTimer = null;
  }

  // Debounced: a pushed result arrives as several chunks; announce once.
  #flushAnnouncement() {
    const text = this.announceBuffer.join("").trim();
    this.announceBuffer = [];
    if (!text) return;
    logger.info("Out-of-turn message from hermes", { chars: text.length });
    this.onAnnouncement?.(text);
  }

  // A client whose child has exited must never be handed to a caller: the
  // failure would surface as a broken turn instead of a transparent respawn.
  isAlive() {
    return Boolean(this.child) && !this.dead && this.child.exitCode === null;
  }

  async start() {
    // -p <profile>: the voice profile carries no MCP servers and only
    // memory/delegation/clarify toolsets, so a turn costs a fraction of the
    // default profile's 135-165k tokens. Work is delegated to subagents that
    // DO have tools. Honcho (the user model) is shared via workspace.
    const profile = process.env.HERMES_VOICE_PROFILE || "voice";
    this.child = spawn("hermes", ["-p", profile, "acp"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (d) => {
      const line = d.toString().trim();
      if (line) logger.debug("hermes stderr", { line: line.slice(0, 200) });
    });
    this.child.stdout.on("data", (data) => this.#onData(data));
    this.child.on("exit", (code, signal) => {
      this.dead = true;
      logger.info("ACP child exited", { code, signal, sessionId: this.sessionId });
      // Fail every in-flight request so callers surface an error instead of
      // hanging until timeout (M2.T2 graceful-failure gate).
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error(`hermes acp exited (code ${code}, signal ${signal})`));
      }
    });

    return this.#request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
      INIT_TIMEOUT_MS
    );
  }

  async newSession() {
    const res = await this.#request(
      "session/new",
      { cwd: this.cwd, mcpServers: [] },
      SESSION_TIMEOUT_MS
    );
    this.sessionId = res?.sessionId ?? null;
    logger.info("ACP session created", { sessionId: this.sessionId });
    return this.sessionId;
  }

  // Send a user turn; resolves { text, stopReason, ms }.
  // Serialized: hermes answers "Queued for the next turn" if a second prompt
  // arrives while one is in flight, and that string gets spoken at the user.
  prompt(text) {
    const run = () => this.#promptNow(text);
    const result = this.promptChain.then(run, run);
    // The next prompt waits for this one PLUS a drain window, so trailing
    // chunks settle before a new turn starts collecting.
    const drain = () => new Promise((r) => setTimeout(r, DRAIN_MS));
    this.promptChain = result.then(drain, drain);
    return result;
  }

  async #promptNow(text) {
    if (!this.sessionId) throw new Error("no ACP session");
    this.chunks = [];
    const started = Date.now();
    this.inFlight = true;
    let res;
    try {
      res = await this.#request(
        "session/prompt",
        { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
        PROMPT_TIMEOUT_MS
      );
    } finally {
      this.inFlight = false;
      this.lastPromptEndMs = Date.now();
    }
    return {
      text: this.chunks.join("").trim(),
      stopReason: res?.stopReason ?? "unknown",
      ms: Date.now() - started,
    };
  }

  // Barge-in: notification, not a request [A8]. Pending permission requests
  // must then be answered "cancelled" [A9].
  cancel() {
    if (!this.sessionId || !this.child) return false;
    // [A8] cancels ONGOING operations. Sending it with no turn in flight is
    // meaningless — and empirically corrupts hermes' ACP adapter, which then
    // fails the NEXT prompt with "'NoneType' object has no attribute
    // 'startswith'". Barge-in on a first utterance hits exactly this.
    if (!this.inFlight) return false;
    this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    for (const [id] of this.pendingPermissions) {
      this.#send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
    }
    this.pendingPermissions.clear();
    logger.info("session/cancel sent", { sessionId: this.sessionId });
    return true;
  }

  // Permission policy [A9]: auto-allow read-class work only. Anything that can
  // change state waits for a spoken yes/no — a misheard sentence must never
  // silently approve a destructive action.
  decidePermission(params) {
    const kind = params?.toolCall?.kind ?? "";
    const title = params?.toolCall?.title ?? "";
    const readish = READ_KINDS.has(kind) || READ_TITLE.test(title);
    if (!readish) return { autoAnswer: false, optionId: null, reason: "not read-class" };
    const allow = (params.options ?? []).find((o) => o.kind === "allow_once")
      ?? (params.options ?? []).find((o) => o.kind === "allow_always");
    return allow
      ? { autoAnswer: true, optionId: allow.optionId, reason: "read-class" }
      : { autoAnswer: false, optionId: null, reason: "no allow option offered" };
  }

  rejectOptionId(params) {
    const rej = (params.options ?? []).find((o) => o.kind === "reject_once")
      ?? (params.options ?? []).find((o) => o.kind === "reject_always");
    return rej?.optionId ?? null;
  }

  answerPermission(requestId, optionId) {
    this.#send({
      jsonrpc: "2.0",
      id: requestId,
      result: { outcome: { outcome: "selected", optionId } },
    });
    this.pendingPermissions.delete(requestId);
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.stdin.end(); } catch { /* already closed */ }
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  // ---- internals ----

  #onData(data) {
    this.buffer += data.toString("utf8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // stdout is messages-only [A7]
      this.#handle(msg);
    }
  }

  #handle(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }

    if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        if (this.inFlight) {
          this.chunks.push(u.content.text);
          this.onChunk?.(u.content.text);
        } else if (Date.now() - this.lastPromptEndMs < TAIL_MS) {
          // Trailing fragment of the reply that just finished — not news.
          logger.debug("Discarded post-reply tail chunk", { chars: u.content.text.length });
        } else {
          // Out-of-turn message: hermes pushes background results back as
          // ordinary messages [H10]. Buffering it with prompt chunks would
          // splice a completion into the NEXT unrelated reply.
          this.announceBuffer.push(u.content.text);
          clearTimeout(this.announceTimer);
          this.announceTimer = setTimeout(() => this.#flushAnnouncement(), 1200);
        }
      }
      return;
    }

    if (msg.id !== undefined && msg.method === "session/request_permission") {
      const decision = this.decidePermission(msg.params);
      if (decision.autoAnswer) {
        logger.info("Permission auto-allowed (read-class)", { title: msg.params?.toolCall?.title });
        this.answerPermission(msg.id, decision.optionId);
      } else {
        this.pendingPermissions.set(msg.id, msg.params);
        logger.warn("Permission requires confirmation", {
          title: msg.params?.toolCall?.title,
          reason: decision.reason,
        });
        this.onPermission?.(msg.id, msg.params);
      }
      return;
    }

    if (msg.id !== undefined && msg.method) {
      this.#send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not supported by voice client" },
      });
    }
  }

  #send(obj) {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  #request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }
}
