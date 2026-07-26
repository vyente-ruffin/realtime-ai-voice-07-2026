// Local server for live voice conversation with gpt-realtime-2.1 via WebRTC.
// Serves talk.html and mints ephemeral keys (GA endpoint: /openai/v1/realtime/client_secrets)
// so the real Entra token never reaches the browser.
//
// Auth: uses AZURE_TOKEN if provided (pre-fetched Entra token for
// https://ai.azure.com), otherwise falls back to DefaultAzureCredential.

import { createServer } from "node:http";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import { getLogger } from "./src/core/logger.js";

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

function authorized(req, url) {
  const token = req.headers["x-voice-auth"] || url.searchParams.get("auth");
  if (token !== AUTH_TOKEN) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  return true;
}

// SSE clients for server->browser control messages (M1.T2 /speak relay).
const sseClients = new Set();

function sseBroadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

async function getEntraToken() {
  if (process.env.AZURE_TOKEN) return process.env.AZURE_TOKEN;
  const credential = new DefaultAzureCredential();
  const provider = getBearerTokenProvider(
    credential,
    "https://ai.azure.com/.default"
  );
  return provider();
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
    if (pathname === "/token" || pathname === "/speak" || pathname === "/turn" || pathname === "/events") {
      if (!authorized(req, url)) {
        problem(res, 403, "Forbidden", "Missing or invalid voice auth token.");
        return;
      }
    }

    if (req.method === "POST" && pathname === "/token") {
      const settings = parseSettings(await readBody(req));

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
          receivedAt: Date.now(),
        }) + "\n"
      );
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
server.listen(PORT, process.env.HOST || "127.0.0.1", () => {
  logger.info("Talk server ready", {
    url: `http://localhost:${PORT}`,
    endpoint,
    deployment: deploymentName,
  });
});
