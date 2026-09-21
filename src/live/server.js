import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { getLogger } from "../core/logger.js";
import { VoiceStore, liveHistory, joinedTurns } from "./store.js";
import { AzureLive } from "./azure.js";
import { VoiceMemory } from "./memory.js";
import { VoiceWorker } from "./worker.js";
import { instructions } from "./policy.js";
const logger = await getLogger("live.server");
const root = resolve(import.meta.dirname, "../..");
const port = Number(process.env.PORT || 8789);
const pageTemplate = readFileSync(join(root, "talk.html"), "utf8");
const browserScript = readFileSync(join(root, "web/live.js"), "utf8");
const buildId = createHash("sha256")
  .update(browserScript)
  .update(
    ["azure.js", "memory.js", "policy.js", "server.js", "store.js", "worker.js"]
      .map((name) => readFileSync(join(root, "src/live", name), "utf8"))
      .join(""),
  )
  .digest("hex")
  .slice(0, 16);
const auth = randomBytes(24).toString("hex");
const store = new VoiceStore(
  process.env.VOICE_STATE_PATH || join(root, "logs/live/state.sqlite"),
);
store.recover();
const azure = new AzureLive({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  subscription:
    process.env.AZURE_SUBSCRIPTION_ID || "e1e5b742-d76b-4ce5-97d3-8d820bb33904",
});
const memory = new VoiceMemory({
  configPath:
    process.env.HINDSIGHT_CONFIG_PATH ||
    resolve(process.env.HOME, ".hermes/profiles/voice/hindsight/config.json"),
  modelIds: (
    process.env.VOICE_MEMORY_MODELS || "v-profile-and-standards,personal,work"
  )
    .split(",")
    .filter(Boolean),
  store,
  onState: (state) =>
    publish(state.conversation, { type: "memory.state", state: state.state }),
});
const subscribers = new Map();
function publish(conversation, event) {
  for (const res of subscribers.get(conversation) || [])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}
const worker = new VoiceWorker({
  store,
  onUpdate: (job) =>
    publish(job.conversation, { type: "job.updated", job: publicJob(job) }),
});
function publicJob(job) {
  return {
    ...job,
    request: undefined,
    delivery: store.delivery(job.id)?.state || "available",
    permissions: [...worker.permissions.values()]
      .filter((p) => p.job === job.id)
      .map((p) => ({
        id: p.id,
        title: p.toolCall?.title || "Permission needed",
        options: p.options,
      })),
  };
}
function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
function problem(res, status, title, retryAfterMs = 0) {
  res.writeHead(status, {
    "Content-Type": "application/problem+json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({ type: "about:blank", status, title, detail: title }),
  );
}
function allowed(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (
      [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
        process.env.VOICE_PUBLIC_ORIGIN,
      ].includes(origin) ||
      (u.protocol === "https:" && u.hostname.endsWith(".ts.net"))
    );
  } catch {
    return false;
  }
}
async function body(req) {
  let bytes = 0,
    s = "";
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 131072)
      throw Object.assign(new Error("Request is too large."), { status: 413 });
    s += chunk;
  }
  try {
    return JSON.parse(s || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { status: 400 });
  }
}
function requireConversation(id) {
  const c = store.conversation(id);
  if (!c)
    throw Object.assign(new Error("Conversation not found."), { status: 404 });
  return c;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && ["/", "/talk.html"].includes(url.pathname)) {
      // Reuse the current app's markup and styling; only its conversation script changes.
      const html = pageTemplate
        .replace("__VOICE_AUTH__", auth)
        .replace(
          /<script>[\s\S]*?<\/script>/,
          '<script type="module" src="/web/live.js"></script>',
        );
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/web/live.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-store",
      });
      res.end(browserScript);
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, {
        status: memory.prepared.length ? "ready" : "degraded",
        voice: "gpt-live",
        buildId,
        preparedMemories: memory.prepared.length,
        memoryWarning: memory.lastError,
        workerReady: Boolean(worker.client?.sessionId && !worker.readyPromise),
        memorySaves: store.memoryHealth(),
        uptimeSeconds: Math.round(process.uptime()),
      });
      return;
    }
    if (!allowed(req.headers.origin)) {
      problem(res, 403, "Origin not allowed.");
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth-refresh") {
      json(res, 200, { token: auth });
      return;
    }
    if (
      (req.headers["x-voice-auth"] || url.searchParams.get("auth")) !== auth
    ) {
      problem(res, 403, "Refresh the page to reconnect.");
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const b = await body(req);
      const c =
        process.env.VOICE_QUALIFICATION === "1" && b.isolated
          ? store.conversation(b.id) || store.createConversation()
          : store.defaultConversation();
      json(res, 200, {
        id: c.id,
        jobs: store.jobs(c.id).map(publicJob),
        history: joinedTurns(store.history(c.id)),
        memoryReady: memory.prepared.length > 0,
      });
      return;
    }
    const conversationId = url.searchParams.get("conversation");
    if (req.method === "GET" && url.pathname === "/api/events") {
      requireConversation(conversationId);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(
        `data: ${JSON.stringify({ type: "session.active", session: store.conversation(conversationId).active_session })}\n\n`,
      );
      const list = subscribers.get(conversationId) || new Set();
      list.add(res);
      subscribers.set(conversationId, list);
      res.write(
        `data: ${JSON.stringify({ type: "snapshot", jobs: store.jobs(conversationId).map(publicJob) })}\n\n`,
      );
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
      res.on("close", () => {
        clearInterval(keepalive);
        list.delete(res);
        if (!list.size) subscribers.delete(conversationId);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      requireConversation(conversationId);
      json(res, 200, { jobs: store.jobs(conversationId).map(publicJob) });
      return;
    }
    const b = await body(req);
    const conversation = requireConversation(b.conversation);
    if (req.method === "POST" && url.pathname === "/api/live") {
      if (b.synthetic && process.env.VOICE_QUALIFICATION !== "1") {
        problem(
          res,
          400,
          "Synthetic audio requires an isolated qualification instance.",
        );
        return;
      }
      if (
        typeof b.sdp !== "string" ||
        b.sdp.length > 65536 ||
        !b.sdp.startsWith("v=0")
      ) {
        problem(res, 400, "A valid voice connection offer is required.");
        return;
      }
      const voice = [
        "cedar",
        "marin",
        "quartz",
        "ripple",
        "vesper",
        "willow",
        "stone",
        "gleam",
        "meridian",
        "bossa",
        "tempo",
        "beacon",
        "delta",
        "cinder",
      ].includes(b.voice)
        ? b.voice
        : "cedar";
      const started = Date.now();
      const value = await azure.session({
        sdp: b.sdp,
        voice,
        instructions: instructions(
          memory.context(),
          store.jobs(conversation.id),
        ),
        history: liveHistory(store.history(conversation.id)),
      });
      store.activate(conversation.id, value.session.id);
      publish(conversation.id, {
        type: "session.active",
        session: value.session.id,
      });
      store.audit(conversation.id, "session.started", {
        session: value.session.id,
        connectionMs: Date.now() - started,
        preparedMemoryCount: memory.prepared.length,
      });
      json(res, 200, {
        session: value.session,
        transport: value.transport,
        memoryReady: memory.prepared.length > 0,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/transcript") {
      if (!Array.isArray(b.events) || b.events.length > 200) {
        problem(res, 400, "A transcript batch is required.");
        return;
      }
      for (const event of b.events)
        if (typeof event.delta === "string" && event.delta.length < 8000)
          store.fragment(
            conversation.id,
            String(b.session).slice(0, 200),
            event,
          );
      json(res, 200, { saved: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delegations") {
      if (conversation.active_session !== b.session) {
        problem(res, 409, "This voice connection has been replaced.");
        return;
      }
      if (typeof b.delegation !== "string" || b.delegation.length > 200) {
        problem(res, 400, "A delegation identifier is required.");
        return;
      }
      for (const event of (b.events || []).slice(0, 200))
        if (typeof event.delta === "string" && event.delta.length < 8000)
          store.fragment(conversation.id, b.session, event);
      const turns = joinedTurns(store.history(conversation.id));
      if (!turns.some((x) => x.role === "user")) {
        problem(res, 409, "The request transcript has not arrived yet.");
        return;
      }
      const job = store.enqueue(
        conversation.id,
        b.session,
        b.delegation,
        turns
          .slice(-8)
          .map((t) => `${t.role}: ${t.text}`)
          .join("\n"),
      );
      json(res, 202, { job: publicJob(job) });
      publish(conversation.id, { type: "job.updated", job: publicJob(job) });
      void worker.kick();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delivery") {
      const job = store.job(b.job);
      if (!job || job.conversation !== conversation.id) {
        problem(res, 404, "Task not found.");
        return;
      }
      if (conversation.active_session !== b.session) {
        problem(res, 409, "This voice connection has been replaced.");
        return;
      }
      if (b.action === "offer") {
        if (
          !["completed", "failed", "interrupted", "cancelled"].includes(
            job.state,
          )
        ) {
          problem(res, 409, "Task has no final result yet.");
          return;
        }
        const offer = store.offer(job, b.session);
        json(res, 200, { offer, job: publicJob(job) });
        return;
      }
      if (b.action === "accepted")
        store.deliveryAck(job.id, b.session, b.event);
      else if (b.action === "not_sent")
        store.releaseOffer(job.id, b.session, b.event);
      else if (b.action === "playback_observed")
        store.audit(conversation.id, "result.playback_observed", {
          job: job.id,
          event: b.event,
        });
      else {
        problem(res, 400, "Unknown delivery action.");
        return;
      }
      json(res, 200, { saved: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/tasks/cancel") {
      const job = store.job(b.job);
      if (!job || job.conversation !== conversation.id) {
        problem(res, 404, "Task not found.");
        return;
      }
      json(res, 200, { job: publicJob(worker.cancel(job)) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/permission") {
      const job = store.job(b.job);
      if (!job || job.conversation !== conversation.id) {
        problem(res, 404, "Task not found.");
        return;
      }
      worker.answer(job.id, b.id, b.optionId);
      json(res, 200, { saved: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/audit") {
      store.audit(conversation.id, String(b.kind).slice(0, 100), {
        session: b.session,
        at: b.at,
      });
      json(res, 200, { saved: true });
      return;
    }
    problem(res, 404, "Not found.");
  } catch (err) {
    logger.warn("Voice request failed", {
      path: url.pathname,
      error: err.message,
    });
    if (!res.headersSent)
      problem(res, err.status || 502, err.message, err.retryAfterMs);
    else res.end();
  }
});
server.requestTimeout = 25000;
server.headersTimeout = 10000;
const memoryTick = setInterval(
  () =>
    void memory
      .drain()
      .catch((err) =>
        logger.warn("Memory queue error", { error: err.message }),
      ),
  1000,
);
const refreshTick = setInterval(() => void memory.refresh(), 60000);
await memory.refresh();
void azure
  .accessToken()
  .catch((err) => logger.warn("Azure warmup pending", { error: err.message }));
void worker
  .warm()
  .then(() => worker.kick())
  .catch((err) => logger.warn("Hermes warmup pending", { error: err.message }));
server.listen(port, process.env.HOST || "127.0.0.1", () =>
  logger.info("Jarvis voice ready", {
    port,
    preparedMemories: memory.prepared.length,
  }),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    clearInterval(memoryTick);
    clearInterval(refreshTick);
    worker.stop();
    server.close();
    for (const list of subscribers.values()) for (const res of list) res.end();
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 500).unref();
  });
