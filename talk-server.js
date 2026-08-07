// Local server for live voice conversation with gpt-realtime-2.1 via WebRTC.
// Serves talk.html and mints ephemeral keys (GA endpoint: /openai/v1/realtime/client_secrets)
// so the real Entra token never reaches the browser.
//
// Auth: uses AZURE_TOKEN if provided (pre-fetched Entra token for
// https://ai.azure.com), otherwise falls back to DefaultAzureCredential.

import { createServer } from "node:http";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import { getLogger } from "./src/core/logger.js";
import { AcpClient } from "./src/acp-client.js";
import {
  answerProvenanceForQuestion,
  cancellationNeedsReplacement,
  formatTaskReceipt,
  normalizeProvenance,
  provenanceForTurnPayload,
  shouldBootstrapBrain,
  shouldDetachAtBoundary,
  splitAtThreshold,
} from "./src/background-turn.js";

const logger = await getLogger("talk-server");

const PORT = Number(process.env.PORT || 8787);
const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT is not set.");
if (!deploymentName) throw new Error("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");

const here = dirname(fileURLToPath(import.meta.url));

const VOICES = [
  "marin", "cedar", "alloy", "ash", "ballad",
  "coral", "echo", "sage", "shimmer", "verse",
];
const DEFAULT_VOICE = "cedar";
const DEFAULT_INSTRUCTIONS =
  "You are a friendly voice assistant helping test a GPT Realtime deployment on Azure AI Foundry. Keep replies conversational and brief.";

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Everything the browser sends is untrusted; validate/clamp each field.
function parseSettings(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw || "{}");
  } catch {
    cfg = {};
  }
  return {
    voice: VOICES.includes(cfg.voice) ? cfg.voice : DEFAULT_VOICE,
    speed: clamp(cfg.speed, 0.25, 1.5, 1.0),
    silenceMs: Math.round(clamp(cfg.silence_duration_ms, 100, 3000, 500)),
    noiseReduction: ["near_field", "far_field"].includes(cfg.noise_reduction)
      ? cfg.noise_reduction
      : null,
    instructions:
      typeof cfg.instructions === "string" && cfg.instructions.trim()
        ? cfg.instructions.trim().slice(0, 4000)
        : DEFAULT_INSTRUCTIONS,
    // Puppet mode [MS3][C2]: VAD detects turns but the model never
    // self-responds; all speech is injected via response.create [MS6].
    puppet: cfg.puppet === true,
  };
}

const logsDir = join(here, "logs");
mkdirSync(logsDir, { recursive: true });

// Per-process auth token (security review 2026-07-26): injected into the
// served page; required on every API call. A custom header can't be sent by
// CSRF simple requests, which closes the cross-origin abuse path on /token,
// /speak, and — critically for M2, where it becomes hermes' prompt input —
// /turn. EventSource can't set headers, so /events accepts ?auth=.
const AUTH_TOKEN = randomBytes(24).toString("hex");
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
// Tailscale serve proxies https://<host>.<tailnet>.ts.net -> this loopback
// port, so a phone's Origin is the tailnet hostname. Allow *.ts.net over
// HTTPS: reaching it already requires being on the tailnet, and the
// per-process auth token is still required on every call.
function originAllowed(origin) {
  if (!origin) return true;                       // non-browser callers
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.hostname.endsWith(".ts.net");
  } catch {
    return false;
  }
}

function authorized(req, url) {
  const token = req.headers["x-voice-auth"] || url.searchParams.get("auth");
  if (token !== AUTH_TOKEN) return false;
  if (!originAllowed(req.headers.origin)) return false;
  return true;
}

// SSE clients for server->browser control messages (M1.T2 /speak relay).
const sseClients = new Set();

function sseBroadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

// Azure tokens last ~60-90 min. Minting once at startup meant the server
// silently rotted: every session started after that hour failed with
// "Azure returned 401". Mint on demand and cache until 5 minutes before
// expiry instead.
let tokenCache = { value: null, expiresAtMs: 0 };
const AZ_SUBSCRIPTION = process.env.AZURE_SUBSCRIPTION_ID || "e1e5b742-d76b-4ce5-97d3-8d820bb33904";

async function getEntraToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAtMs - 300_000) return tokenCache.value;

  // az CLI first: this account's resource lives in a non-default tenant, so
  // DefaultAzureCredential picks the wrong identity (see CLAUDE.md gotcha #1).
  try {
    const out = execFileSync("az", [
      "account", "get-access-token",
      "--subscription", AZ_SUBSCRIPTION,
      "--resource", "https://ai.azure.com",
      "-o", "json",
    ], { encoding: "utf8", timeout: 30_000 });
    const j = JSON.parse(out);
    const expMs = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn);
    tokenCache = { value: j.accessToken, expiresAtMs: Number.isFinite(expMs) ? expMs : now + 3_600_000 };
    logger.info("Azure token refreshed", { expiresIn: Math.round((tokenCache.expiresAtMs - now) / 60000) + "m" });
    return tokenCache.value;
  } catch (err) {
    logger.warn("az token mint failed; falling back", { error: String(err.message).slice(0, 120) });
  }

  if (process.env.AZURE_TOKEN) return process.env.AZURE_TOKEN;
  const credential = new DefaultAzureCredential();
  return getBearerTokenProvider(credential, "https://ai.azure.com/.default")();
}

// ---- The brain: one foreground ACP child, replaced only when a turn detaches ----
let brain = null;
let brainStarting = null;
const activeForegroundPrompts = new Map();

async function createBrain(reason = "between-turn-recovery") {
  const client = new AcpClient({
    cwd: here,
    onAnnouncement: (text) => announce(text, {
      question: "ACP out-of-turn announcement",
      questionProvenance: "unknown/needs review",
      answerProvenance: "assistant-authored",
    }),
  });
  await client.start();
  const sessionId = await client.newSession();
  const bootstrap = shouldBootstrapBrain(reason);
  // The first conversational child receives the application bootstrap. A
  // replacement created while background work is active skips this extra model
  // turn so unrelated speech does not pay its latency.
  if (bootstrap) {
    try {
      await client.prompt(DELEGATION_PREAMBLE);
    } catch (err) {
      logger.warn("Delegation preamble failed", { error: err.message, reason });
    }
  }
  writeFileSync(
    join(logsDir, "acp-session.json"),
    JSON.stringify({
      acpSessionId: sessionId,
      startedAt: new Date().toISOString(),
      reason,
      bootstrapProvenance: bootstrap ? "application bootstrap" : "not sent",
    })
  );
  return client;
}

async function getBrain(reason = "between-turn-recovery") {
  if (brain && !brain.isAlive()) {
    logger.warn("Brain child died between turns; respawning");
    brain = null;
  }
  if (brain) return brain;
  if (brainStarting) return brainStarting;
  const starting = createBrain(reason).then((client) => {
    brain = client;
    return client;
  });
  brainStarting = starting;
  try {
    return await starting;
  } finally {
    if (brainStarting === starting) brainStarting = null;
  }
}

// Fillers: spoken while hermes thinks. Out-of-band so they never enter the
// conversation state and never reach hermes' prompt context [C1][C7].
const FILLERS = [
  "One sec, checking on that.",
  "Let me think about that for a moment.",
  "Still with you — working on it.",
  "Hang on, pulling that together.",
  "Give me a beat on this one.",
];
// Raised from 1500ms: with the lean voice profile most replies land in ~2s,
// so a 1.5s filler fired on nearly every turn and just delayed the answer.
// Only cover genuinely slow turns (tool use, delegation).
const FILLER_AFTER_MS = Number(process.env.VOICE_FILLER_MS || 4000);
// The voice contract is stricter than the model prompt: dead air may never
// exceed ~15s even when Hermes ignores the delegation preamble and starts
// foreground research. At this boundary the current ACP session becomes a
// real background worker and a fresh session is available for new turns.
const BACKGROUND_AFTER_MS = 15_000;
let lastFillerIndex = -1;

function nextFiller() {
  let i;
  do { i = Math.floor(Math.random() * FILLERS.length); }
  while (i === lastFillerIndex && FILLERS.length > 1);
  lastFillerIndex = i;
  return FILLERS[i];
}

function sendFiller() {
  const text = nextFiller();
  sseBroadcast({ type: "filler", text });
  appendFileSync(
    join(logsDir, "fillers.log"),
    JSON.stringify({ at: new Date().toISOString(), text, conversation: "none", purpose: "filler" }) + "\n"
  );
  return text;
}

// Barge-in state: set when the user interrupts, so a late hermes reply is
// dropped instead of spoken at a moment the user has already moved past [A8].
let turnEpoch = 0;
let lastHermesReply = "";  // for the spoken-vs-said audit
let lastQuestion = "";
let lastQuestionProvenance = "unknown/needs review";

export async function bargeIn() {
  setUserSpeaking(true);
  // The epoch always advances so a late reply is dropped; the protocol cancel
  // only goes out when the foreground Hermes worker actually has work in
  // flight [A8]. Detached background workers are intentionally unreachable
  // here, so a new question cannot cancel unrelated long-running work.
  turnEpoch += 1;
  let affected = brain?.isBusy() ? brain : null;
  let detachedAtBoundary = false;
  const active = affected ? activeForegroundPrompts.get(affected) : null;
  if (affected && active && shouldDetachAtBoundary(active.startedAt, Date.now(), BACKGROUND_AFTER_MS)) {
    // A speech-start event can race the 15-second timer by a few milliseconds.
    // Once the boundary has elapsed, preserve that work as background instead
    // of cancelling it as if it were still an ordinary foreground turn.
    detachedAtBoundary = true;
    activeForegroundPrompts.delete(affected);
    if (brain === affected) brain = null;
    void getBrain("background-replacement").catch((err) => {
      logger.warn("Boundary-race replacement warm-up failed", { error: err.message });
    });
  }
  const outcome = detachedAtBoundary
    ? { sent: false, completed: true, stopReason: "detached_at_boundary", error: null }
    : affected
      ? await affected.cancelAndWait(2_000)
      : { sent: false, completed: true, stopReason: "not_in_flight", error: null };
  appendFileSync(
    join(logsDir, "cancel.log"),
    JSON.stringify({
      at: new Date().toISOString(),
      event: detachedAtBoundary
        ? "foreground-detached-at-boundary"
        : outcome.sent ? "session/cancel-completed" : "barge-in-noop",
      epoch: turnEpoch,
      sessionId: affected?.sessionId ?? null,
      completed: outcome.completed,
      stopReason: outcome.stopReason,
      error: outcome.error,
    }) + "\n"
  );
  if (affected && !detachedAtBoundary && cancellationNeedsReplacement(outcome)) {
    // Cancellation itself is bounded. If ACP does not prove `cancelled`, kill
    // only that stuck child and warm a replacement; never restart the server.
    if (brain === affected) brain = null;
    await affected.stop();
    appendFileSync(
      join(logsDir, "cancel.log"),
      JSON.stringify({
        at: new Date().toISOString(),
        event: "stuck-worker-replaced",
        epoch: turnEpoch,
        sessionId: affected.sessionId,
        priorStopReason: outcome.stopReason,
      }) + "\n"
    );
    void getBrain("cancellation-replacement").catch((err) => {
      logger.warn("Post-cancellation replacement warm-up failed", { error: err.message });
    });
  }
  return outcome;
}

// Mock brain for timing gates: real hermes latency varies 4-30s, which cannot
// prove a 1.5s filler threshold. Enabled only via VOICE_MOCK_BRAIN=1.
function mockDelayFor(transcript) {
  const m = /MOCK_DELAY_(\d+)/.exec(transcript);
  return m ? Number(m[1]) : 800;
}

// Announcements: completions hermes pushes back out-of-turn [H10]. They must
// never land on top of the user — an assistant that interrupts you to report a
// finished task is worse than one that waits.
let userSpeaking = false;
const announceQueue = [];
const expectedSpeechQueue = [];

function rememberExpectedSpeech(text, metadata = {}) {
  expectedSpeechQueue.push({
    text,
    question: metadata.question ?? lastQuestion,
    questionProvenance: normalizeProvenance(
      metadata.questionProvenance ?? lastQuestionProvenance
    ),
    answerProvenance: normalizeProvenance(
      metadata.answerProvenance ?? "assistant-authored"
    ),
  });
}

function logAnnouncement(event, text) {
  appendFileSync(
    join(logsDir, "announcements.log"),
    JSON.stringify({ at: new Date().toISOString(), event, text: text.slice(0, 300) }) + "\n"
  );
}

function logBackgroundTurn(event, fields = {}) {
  const provenance = normalizeProvenance(fields.provenance);
  appendFileSync(
    join(logsDir, "background-turns.log"),
    JSON.stringify({ at: new Date().toISOString(), event, ...fields, provenance }) + "\n"
  );
}

function announce(text, metadata = {}) {
  if (userSpeaking) {
    announceQueue.push({ text, metadata });
    logAnnouncement("deferred", text);
    return false;
  }
  if (sseClients.size > 0) rememberExpectedSpeech(text, metadata);
  sseBroadcast({ type: "speak", text: text.slice(0, 4000) });
  logAnnouncement("announced", text);
  return true;
}

function setUserSpeaking(speaking) {
  userSpeaking = speaking;
  if (!speaking) {
    while (announceQueue.length && !userSpeaking) {
      const pending = announceQueue.shift();
      announce(pending.text, pending.metadata);
    }
  }
}

// Preamble that makes delegation machine-checkable: hermes must emit literal
// sentinels so gates grep rather than guess. Delegation is process-local [H9],
// so anything that must outlive the call belongs in cron.
const DELEGATION_PREAMBLE = [
  "You are answering by voice. Two rules for long-running work:",
  "1. If a task will take more than ~15 seconds, start it in the background",
  "   (delegate_task with background execution, or a background terminal),",
  "   then reply IMMEDIATELY with the literal token TASK-ACCEPTED <handle>,",
  "   where <handle> is the delegation or session id. Never wait for the result.",
  "2. When asked about a task, reply with TASK-RUNNING <handle> or",
  "   TASK-DONE <handle> plus one short sentence. Keep replies conversational",
  "   and brief — they are spoken aloud.",
].join(" ");

// TASK-* sentinels exist so the gates can grep rather than guess [H9][H10].
// They were never meant to be heard: spoken aloud, "TASK-ACCEPTED proc_3839b87"
// becomes "proc underscore 3 8 3 9 b 8 7" — the machine marker read out as
// speech. Strip the sentinel and its handle at the mouth, keep both in the log
// so status lookups and gates still work.
const SENTINEL_SPEECH = {
  "TASK-ACCEPTED": "Starting that now — I'll let you know when it's done.",
  "TASK-RUNNING": "That's still running.",
  "TASK-DONE": "That's finished.",
  "HANDOFF-SCHEDULED": "I'll send the results over when they land.",
};
// Only a leading protocol token is control syntax. A normal answer may mention
// `TASK-ACCEPTED` while explaining the contract; stripping that mid-sentence
// mangles an otherwise valid spoken answer ("returns , continues...").
const SENTINEL_RE = /^\s*(TASK-ACCEPTED|TASK-RUNNING|TASK-DONE|HANDOFF-SCHEDULED)\b[ \t]*([A-Za-z0-9_-]{4,})?/;

let lastTaskHandle = null;

function speakable(text) {
  let sentinel = null;
  const stripped = text.replace(SENTINEL_RE, (_m, tag, handle) => {
    sentinel = tag;
    if (handle) lastTaskHandle = handle;
    return "";
  }).replace(/\s{2,}/g, " ")
    // Removing the sentinel can leave the joining punctuation stranded at the
    // front ("— it's still counting"), which reads as a stumble when spoken.
    .replace(/^[\s—–-]*[,;:]?\s*/, "")
    .trim();
  if (!sentinel) return text;
  appendFileSync(
    join(logsDir, "announcements.log"),
    JSON.stringify({ at: new Date().toISOString(), event: "sentinel-stripped", sentinel, handle: lastTaskHandle }) + "\n"
  );
  // Keep hermes' own sentence when it wrote one; it names the actual task.
  return stripped || SENTINEL_SPEECH[sentinel] || stripped;
}

// Ears -> brain -> mouth. Returns the spoken text, or throws.
async function routeTurn(transcript, inputProvenance = "unknown/needs review") {
  const provenance = provenanceForTurnPayload(inputProvenance);
  lastQuestion = transcript;
  lastQuestionProvenance = provenance;
  const started = Date.now();
  const myEpoch = turnEpoch;
  let fillerAfterMs = null;
  const fillerTimer = setTimeout(() => {
    if (turnEpoch !== myEpoch) return; // user already barged in
    fillerAfterMs = Date.now() - started;
    sendFiller();
  }, FILLER_AFTER_MS);

  let reply;
  try {
    // Mock only when the harness allows it AND the transcript carries the
    // explicit marker, so real-brain gates in m2 stay real.
    if (process.env.VOICE_ALLOW_MOCK === "1" && /MOCK_DELAY_\d+/.test(transcript)) {
      const delay = mockDelayFor(transcript);
      await new Promise((r) => setTimeout(r, delay));
      reply = { text: `MOCK REPLY after ${delay}ms`, stopReason: "end_turn", ms: delay };
    } else {
      let client = null;
      let backgrounded = false;
      const handle = `voice-${randomBytes(4).toString("hex")}`;
      // The 15-second clock wraps acquisition, rotation, and the ACP prompt —
      // not merely model work after a client happens to be available.
      const work = (async () => {
        client = await getBrain();
        if (client.isBusy()) {
          // Never queue two independently timed HTTP turns on one ACP prompt
          // lane. The earlier request keeps this client; the newer request gets
          // a freshly warmed foreground brain.
          if (brain === client) brain = null;
          logger.info("Foreground ACP busy; rotating for concurrent turn", {
            busySession: client.sessionId,
          });
          client = await getBrain("background-replacement");
        }
        // If the response boundary elapsed while ACP was still starting, claim
        // this client as the detached worker before prompting it.
        if (backgrounded && brain === client) {
          brain = null;
          void getBrain("background-replacement").catch((err) => {
            logger.warn("Replacement voice brain warm-up failed", { error: err.message });
          });
        }
        const prompt = client.prompt(transcript);
        if (brain === client) {
          activeForegroundPrompts.set(client, { startedAt: started, epoch: myEpoch });
        }
        return prompt.finally(() => {
          if (activeForegroundPrompts.get(client)?.epoch === myEpoch) {
            activeForegroundPrompts.delete(client);
          }
        });
      })();
      const split = await splitAtThreshold(work, BACKGROUND_AFTER_MS);
      if (!split.background) {
        reply = split.value;
        // Another concurrent request may have rotated this client while its
        // fast answer was still running. It is no longer the reusable brain.
        if (brain !== client) void client.stop();
      } else {
        backgrounded = true;
        // Detach the busy session before returning the receipt. A subsequent
        // spoken turn gets a new ACP child instead of queueing behind this work,
        // and barge-in cannot accidentally cancel the detached task.
        if (brain === client) brain = null;
        logBackgroundTurn("accepted", {
          handle,
          acpSessionId: client?.sessionId ?? null,
          after_ms: Date.now() - started,
          provenance: "server-injected",
        });
        // Start the replacement immediately rather than making the user's next
        // sentence pay ACP initialization + preamble latency.
        void getBrain("background-replacement").catch((err) => {
          logger.warn("Replacement voice brain warm-up failed", { error: err.message });
        });

        void split.continuation
          .then((completed) => {
            if (!completed?.text) {
              throw new Error(`hermes returned no background text (stopReason=${completed?.stopReason ?? "unknown"})`);
            }
            logBackgroundTurn("completed", {
              handle,
              acpSessionId: client?.sessionId ?? null,
              task_ms: completed.ms,
              chars: completed.text.length,
              stopReason: completed.stopReason,
              provenance: "assistant-authored",
            });
            // Keep the machine sentinel/handle in the audit log, but strip it
            // at the mouth just like an agent-originated TASK-DONE message.
            announce(speakable(`TASK-DONE ${handle} ${completed.text}`), {
              question: transcript,
              questionProvenance: provenance,
              answerProvenance: provenance === "synthetic test input"
                ? "synthetic test output"
                : "assistant-authored",
            });
          })
          .catch((err) => {
            logBackgroundTurn("failed", {
              handle,
              acpSessionId: client?.sessionId ?? null,
              error: String(err.message).slice(0, 300),
              provenance: "tool-generated",
            });
            logger.error("Background voice turn failed", { handle, error: err.message });
            announce("That background task hit a snag, so I couldn't finish it.", {
              question: transcript,
              questionProvenance: provenance,
              answerProvenance: provenance === "synthetic test input"
                ? "synthetic test output"
                : "assistant-authored",
            });
          })
          .finally(() => client?.stop());

        reply = {
          text: `TASK-ACCEPTED ${handle} ${formatTaskReceipt(handle)}`,
          stopReason: "background",
          ms: BACKGROUND_AFTER_MS,
        };
      }
    }
  } finally {
    clearTimeout(fillerTimer);
  }
  const turn_ms = Date.now() - started;

  // A reply that lands after the user interrupted answers a question they have
  // already moved past — drop it rather than speak it [A8].
  if (turnEpoch !== myEpoch) {
    appendFileSync(
      join(logsDir, "cancel.log"),
      JSON.stringify({ at: new Date().toISOString(), event: "reply-dropped", turn_ms }) + "\n"
    );
    // Never spoken, so /spoken will never fire for it — record it here or the
    // words are lost. Kept in the audit log so a barge-in still leaves a
    // readable trace of what it was about to say.
    appendFileSync(
      join(logsDir, "voice-audit.log"),
      JSON.stringify({
        at: new Date().toISOString(),
        kind: "dropped",
        question: transcript,
        hermesSaid: reply.text,
        mouthSpoke: "",
        turn_ms,
      }) + "\n"
    );
    logger.info("Late reply dropped after barge-in", { turn_ms });
    return { spoken: null, dropped: true, turn_ms, fillerFired: fillerAfterMs !== null, fillerAfterMs };
  }
  appendFileSync(
    join(logsDir, "turns-routed.log"),
    JSON.stringify({
      at: new Date().toISOString(),
      transcript: transcript.slice(0, 500),
      provenance,
      stopReason: reply.stopReason,
      turn_ms,
      chars: reply.text.length,
    }) + "\n"
  );
  logger.info("Turn routed", { turn_ms, stopReason: reply.stopReason, chars: reply.text.length });
  if (!reply.text) throw new Error(`hermes returned no text (stopReason=${reply.stopReason})`);

  // hermes' memory-recall path prefixes replies with "Ask: <your question>?".
  // Spoken aloud that means hearing your own question read back before the
  // answer, so drop it. Only strips a leading Ask:-line ending in "?".
  const cleaned = reply.text.replace(/^\s*Ask:\s*[^?\n]{0,200}\?\s*/i, "").trim() || reply.text;
  reply.text = speakable(cleaned);
  lastHermesReply = reply.text;
  rememberExpectedSpeech(reply.text, {
    question: transcript,
    questionProvenance: provenance,
    answerProvenance: provenance === "synthetic test input"
      ? "synthetic test output"
      : "assistant-authored",
  });
  sseBroadcast({ type: "speak", text: reply.text.slice(0, 4000) });
  return {
    spoken: reply.text, turn_ms, stopReason: reply.stopReason,
    fillerFired: fillerAfterMs !== null, fillerAfterMs,
  };
}

function problem(res, status, title, detail) {
  res.writeHead(status, { "Content-Type": "application/problem+json" });
  res.end(
    JSON.stringify({ type: "about:blank", title, status, detail })
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/talk.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        readFileSync(join(here, "talk.html"), "utf8").replace("__VOICE_AUTH__", AUTH_TOKEN)
      );
      return;
    }

    // Everything below is API surface: token required (security review).
    if (pathname === "/token" || pathname === "/speak" || pathname === "/turn" || pathname === "/events" || pathname === "/barge-in" || pathname === "/session-end" || pathname === "/spoken" || pathname.startsWith("/test/")) {
      if (!authorized(req, url)) {
        problem(res, 403, "Forbidden", "Missing or invalid voice auth token.");
        return;
      }
    }

    if (req.method === "POST" && pathname === "/token") {
      const rawBody = await readBody(req);
      let rawCfg;
      try { rawCfg = JSON.parse(rawBody || "{}"); } catch { rawCfg = {}; }
      // Classic mode retired at M2 (north-star rule 1): the model never thinks
      // for itself again. Only puppet sessions may be minted.
      if (rawCfg.puppet === false) {
        problem(res, 400, "Classic mode retired",
          "This deployment only mints puppet sessions; the model does not generate its own replies.");
        return;
      }
      const settings = parseSettings(rawBody);
      settings.puppet = true;

      const input = {
        transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: settings.silenceMs,
          create_response: !settings.puppet,
          interrupt_response: true,
        },
      };
      if (settings.noiseReduction) {
        input.noise_reduction = { type: settings.noiseReduction };
      }
      appendFileSync(
        join(logsDir, "session-config.log"),
        JSON.stringify({
          at: new Date().toISOString(),
          puppet: settings.puppet,
          transcriptionModel: input.transcription.model,
          turn_detection: input.turn_detection,
        }) + "\n"
      );

      const token = await getEntraToken();
      const upstream = await fetch(`${endpoint}/openai/v1/realtime/client_secrets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: deploymentName,
            instructions: settings.instructions,
            audio: {
              input,
              output: { voice: settings.voice, speed: settings.speed },
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const body = await upstream.text();
      if (!upstream.ok) {
        logger.error("Ephemeral key request failed", {
          status: upstream.status,
          body,
        });
        problem(
          res,
          502,
          "Ephemeral key request failed",
          `Azure returned ${upstream.status}: ${body}`
        );
        return;
      }

      const data = JSON.parse(body);
      const ephemeralKey = data.value ?? data.client_secret?.value;
      logger.info("Ephemeral key minted", { settings, expiresAt: data.expires_at });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ephemeralKey,
          settings,
          callsUrl: `${endpoint}/openai/v1/realtime/calls`,
          expiresAt: data.expires_at,
        })
      );
      return;
    }

    if (req.method === "POST" && pathname === "/test/announce") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const spoken = announce(String(body.text || "").slice(0, 4000));
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ spoken }));
      return;
    }

    if (req.method === "POST" && pathname === "/test/user-speaking") {
      const body = JSON.parse((await readBody(req)) || "{}");
      setUserSpeaking(body.speaking === true);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/session-end") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const pending = Array.isArray(body.pendingTasks) ? body.pendingTasks : [];
      appendFileSync(
        join(logsDir, "handoff.log"),
        JSON.stringify({ at: new Date().toISOString(), event: "handoff-prompt", pending }) + "\n"
      );
      try {
        const client = await getBrain();
        // Delivery goes through hermes' own platform machinery [LIVE-11]; the
        // voice layer never grows delivery tentacles (north-star rule 1).
        const reply = await client.prompt(
          `The voice session is ending. Pending tasks: ${pending.join(", ") || "none"}. ` +
          "When they finish, deliver the results to me via Telegram using your own " +
          "messaging tools. Reply with the literal token HANDOFF-SCHEDULED plus one short sentence."
        );
        const confirmed = /HANDOFF-SCHEDULED/.test(reply.text);
        appendFileSync(
          join(logsDir, "handoff.log"),
          JSON.stringify({
            at: new Date().toISOString(),
            event: confirmed ? "handoff-confirmed" : "handoff-unconfirmed",
            reply: reply.text.slice(0, 300),
          }) + "\n"
        );
        writeFileSync(
          join(logsDir, "handoff-evidence.json"),
          JSON.stringify({ evidence: reply.text.slice(0, 200), at: new Date().toISOString() })
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ confirmed, reply: reply.text }));
      } catch (err) {
        logger.error("Handoff failed", { error: err.message });
        res.writeHead(502, { "Content-Type": "application/problem+json" });
        res.end(JSON.stringify({ type: "about:blank", title: "Handoff failed", status: 502, detail: err.message }));
      }
      return;
    }

    if (req.method === "POST" && pathname === "/barge-in") {
      void bargeIn().catch((err) => {
        logger.error("Barge-in cancellation failed", { error: err.message });
      });
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/speak") {
      let text;
      try {
        text = JSON.parse((await readBody(req)) || "{}").text;
      } catch {
        text = undefined;
      }
      if (typeof text !== "string" || !text.trim()) {
        problem(res, 400, "Bad request", "Body must be JSON with non-empty 'text'.");
        return;
      }
      sseBroadcast({ type: "speak", text: text.trim().slice(0, 4000) });
      logger.info("Speak injection queued", { chars: text.length, listeners: sseClients.size });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ queued: true, listeners: sseClients.size }));
      return;
    }

    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && pathname === "/spoken") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const spoken = String(body.spokenText || "");
      const FILLERS = /^(One sec|Let me think|Still with you|Hang on|Give me a beat)/i;
      if (FILLERS.test(spoken.trim())) {
        appendFileSync(join(logsDir, "voice-audit.log"),
          JSON.stringify({ at: new Date().toISOString(), kind: "filler", mouthSpoke: spoken }) + "\n");
        res.writeHead(204); res.end(); return;
      }
      const expectedReceipt = expectedSpeechQueue.shift() ?? {
        text: lastHermesReply,
        question: lastQuestion,
        questionProvenance: lastQuestionProvenance,
        answerProvenance: "unknown/needs review",
      };
      const expected = expectedReceipt.text;
      // Fidelity: did the mouth read hermes' words, or improvise its own?
      const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
      const a = new Set(norm(expected)), bSet = new Set(norm(spoken));
      const inter = [...a].filter((w) => bSet.has(w)).length;
      const union = new Set([...a, ...bSet]).size;
      const jaccard = union ? +(inter / union).toFixed(3) : 0;
      appendFileSync(
        join(logsDir, "voice-audit.log"),
        JSON.stringify({
          at: new Date().toISOString(),
          kind: "reply",
          // Stored in full: this file is the conversation record, not a
          // sample of it. Truncating here left replies unreadable after the
          // browser tab closed — the words existed nowhere else.
          question: expectedReceipt.question,
          questionProvenance: expectedReceipt.questionProvenance,
          answerProvenance: expectedReceipt.answerProvenance,
          hermesSaid: expected,
          mouthSpoke: spoken,
          jaccard,
          verdict: jaccard >= 0.6 ? "faithful" : "DIVERGED",
        }) + "\n"
      );
      if (jaccard < 0.6 && expected) {
        logger.error("Mouth diverged from hermes", { jaccard, hermesSaid: expected.slice(0, 120), mouthSpoke: spoken.slice(0, 120) });
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/turn") {
      let turn;
      try {
        turn = JSON.parse((await readBody(req)) || "{}");
      } catch {
        turn = {};
      }
      if (typeof turn.transcript !== "string" || turn.transcript.length > 4000) {
        problem(res, 400, "Bad request", "transcript must be a string of at most 4000 chars");
        return;
      }
      appendFileSync(
        join(logsDir, "turns.log"),
        JSON.stringify({
          item_id: typeof turn.item_id === "string" ? turn.item_id.slice(0, 128) : null,
          transcript: turn.transcript,
          provenance: provenanceForTurnPayload(turn.provenance),
          receivedAt: Date.now(),
        }) + "\n"
      );

      // Their utterance has been transcribed: they have stopped talking, so any
      // announcement deferred mid-sentence may now be spoken.
      setUserSpeaking(false);

      if (turn.route === true && turn.transcript.trim()) {
        try {
          const result = await routeTurn(turn.transcript, turn.provenance);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          logger.error("Turn routing failed", { error: err.message });
          // The user is mid-conversation: say something calm rather than
          // leaving dead air, and report RFC 9457 to the caller.
          announce("I hit a snag reaching my brain — one moment.", {
            question: turn.transcript,
            questionProvenance: provenanceForTurnPayload(turn.provenance),
            answerProvenance: turn.provenance === "synthetic test input"
              ? "synthetic test output"
              : "assistant-authored",
          });
          brain = null; // force a fresh child on the next turn
          res.writeHead(502, { "Content-Type": "application/problem+json" });
          res.end(JSON.stringify({
            type: "about:blank",
            title: "Brain unavailable",
            status: 502,
            detail: err.message,
            fallbackSpoken: true,
          }));
        }
        return;
      }

      res.writeHead(204);
      res.end();
      return;
    }

    problem(res, 404, "Not found", `No route for ${req.method} ${req.url}`);
  } catch (err) {
    logger.error("Request failed", { url: req.url, error: err.message });
    problem(res, 500, "Internal server error", err.message);
  }
});

// Loopback-only by default (security review): LAN access goes through an SSH
// tunnel (which targets localhost). Set HOST=0.0.0.0 explicitly to widen.
// Warm the brain at boot: ACP init costs ~30-60s (hermes loads its full MCP
// tool set), and paying that on the user's first spoken turn is a minute of
// dead air. Failures here are non-fatal — the next turn retries.
getBrain("boot")
  .then((c) => logger.info("Brain warm", { acpSession: c.sessionId }))
  .catch((err) => logger.warn("Brain warm-up failed; will retry on first turn", { error: err.message }));

server.listen(PORT, process.env.HOST || "127.0.0.1", () => {
  logger.info("Talk server ready", {
    url: `http://localhost:${PORT}`,
    endpoint,
    deployment: deploymentName,
  });
});
