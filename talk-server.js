// Local server for live voice conversation with gpt-realtime-2.1 via WebRTC.
// Serves talk.html and mints ephemeral keys (GA endpoint: /openai/v1/realtime/client_secrets)
// so the real Entra token never reaches the browser.
//
// Auth: uses AZURE_TOKEN if provided (pre-fetched Entra token for
// https://ai.azure.com), otherwise falls back to DefaultAzureCredential.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  };
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
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/talk.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(here, "talk.html")));
      return;
    }

    if (req.method === "POST" && req.url === "/token") {
      const settings = parseSettings(await readBody(req));

      const input = {
        transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: settings.silenceMs,
          create_response: true,
          interrupt_response: true,
        },
      };
      if (settings.noiseReduction) {
        input.noise_reduction = { type: settings.noiseReduction };
      }

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

    problem(res, 404, "Not found", `No route for ${req.method} ${req.url}`);
  } catch (err) {
    logger.error("Request failed", { url: req.url, error: err.message });
    problem(res, 500, "Internal server error", err.message);
  }
});

server.listen(PORT, () => {
  logger.info("Talk server ready", {
    url: `http://localhost:${PORT}`,
    endpoint,
    deployment: deploymentName,
  });
});
