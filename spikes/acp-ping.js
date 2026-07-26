// M0.T2 spike — hermes ACP handshake + latency baseline.
// Protocol facts: stdio transport is newline-delimited JSON-RPC; stderr is
// for logs only [A7]. Lifecycle: initialize -> session/new -> session/prompt,
// turn ends with a stopReason [A1][A2][A3][A4][A5].
// Writes tests/baseline/acp-latency.json.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../src/core/logger.js";

const logger = await getLogger("acp-ping");
const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "..", "tests", "baseline", "acp-latency.json");

const INIT_TIMEOUT = 60_000;
const SESSION_TIMEOUT = 120_000;
const PROMPT_TIMEOUT = 240_000;
const ROUNDS = 5;

const child = spawn("hermes", ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[hermes] ${d}`));

let nextId = 1;
const pending = new Map();
let buffer = "";
const chunks = [];

child.stdout.on("data", (data) => {
  buffer += data.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn("Non-JSON line on stdout (violates A7)", { line: line.slice(0, 200) });
      continue;
    }
    handleMessage(msg);
  }
});

function handleMessage(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params?.update;
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      chunks.push(u.content.text);
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // Agent-initiated request. Auto-answer permission requests with the first
    // allow-ish option; everything else gets method-not-found (spec-legal).
    if (msg.method === "session/request_permission") {
      const options = msg.params?.options ?? [];
      const pick =
        options.find((o) => /allow/i.test(o.kind ?? "") || /allow|yes/i.test(o.name ?? "")) ??
        options[0];
      logger.info("Auto-answering permission request", { picked: pick?.optionId });
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: pick?.optionId } } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by spike client" } });
    }
  }
}

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function request(method, params, timeoutMs) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function main() {
  const init = await request(
    "initialize",
    { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    INIT_TIMEOUT
  );
  const protocolVersion = init?.protocolVersion ?? null;
  logger.info("initialize ok", { protocolVersion, agentCapabilities: init?.agentCapabilities });
  if (protocolVersion === null) throw new Error("initialize returned no protocolVersion");

  const session = await request(
    "session/new",
    { cwd: process.cwd(), mcpServers: [] },
    SESSION_TIMEOUT
  );
  const sessionId = session?.sessionId;
  logger.info("session/new ok", { sessionId });
  if (!sessionId) throw new Error("session/new returned no sessionId");

  const samples = [];
  for (let i = 1; i <= ROUNDS; i++) {
    chunks.length = 0;
    const t0 = Date.now();
    const res = await request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: "Reply with exactly the word PONG and nothing else." }] },
      PROMPT_TIMEOUT
    );
    const ms = Date.now() - t0;
    const text = chunks.join("");
    const gotPong = /PONG/i.test(text);
    const stopReason = res?.stopReason ?? "missing";
    logger.info(`round ${i}/${ROUNDS}`, { ms, stopReason, gotPong, textPreview: text.slice(0, 60) });
    if (stopReason !== "end_turn") throw new Error(`round ${i}: stopReason=${stopReason} (want end_turn [A4])`);
    if (!gotPong) throw new Error(`round ${i}: reply lacked PONG: ${text.slice(0, 120)}`);
    samples.push(ms);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(
    baselinePath,
    JSON.stringify({ samples, median, protocolVersion, sessionId, recordedAt: new Date().toISOString() }, null, 2)
  );
  logger.info("baseline written", { baselinePath, median, samples });

  child.stdin.end();
  child.kill("SIGTERM");
  process.exit(0);
}

main().catch((err) => {
  logger.error("spike failed", { error: err.message });
  try { child.kill("SIGTERM"); } catch { /* already dead */ }
  process.exit(1);
});
