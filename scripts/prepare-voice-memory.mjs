// Configure only the voice-owned models through Hindsight's supported API.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { voiceMemoryModels, maxMemoryCharacters } from "../src/live/memory-models.js";
import { getLogger } from "../src/core/logger.js";
const logger = await getLogger("voice.memory-setup");
const config = JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG_PATH || resolve(process.env.HOME, ".hermes/profiles/voice/hindsight/config.json"), "utf8"));
const root = `${(config.api_url || config.apiUrl).replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(config.bank_id || config.bankId)}`;
async function request(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(root + path, {
    method,
    headers: { Authorization: `Bearer ${config.apiKey || config.api_key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`Hindsight returned ${response.status} for ${path}.`);
  return response.json();
}
async function prepare(spec) {
  const path = `/mental-models/${spec.id}`;
  let model = await request(path);
  let operation;
  if (!model) operation = (await request("/mental-models", spec)).operation_id;
  else {
    const { id, ...settings } = spec;
    const changed = Object.entries(settings).some(([key, value]) => key === "trigger"
      ? Object.entries(value).some(([field, expected]) => model.trigger?.[field] !== expected)
      : model[key] !== value);
    if (changed) {
      await request(path, settings, "PATCH");
      operation = (await request(path + "/refresh", {})).operation_id;
      model = null;
    } else if (!model.content) operation = (await request(path + "/refresh", {})).operation_id;
  }
  const deadline = Date.now() + 180000;
  while ((!model?.content || operation) && Date.now() < deadline) {
    if (operation) {
      const result = await request(`/operations/${operation}`);
      if (["failed", "cancelled"].includes(result?.status)) throw new Error(`Preparation failed for ${spec.id}.`);
      if (result?.status === "completed") operation = null;
    }
    model = await request(path);
    if (model?.content && !operation) break;
    await delay(2000);
  }
  if (!model?.content || operation) throw new Error(`${spec.id} is still preparing; its operation remains queued.`);
  if (model.content.length > maxMemoryCharacters)
    throw new Error(`${spec.id} exceeds the voice context limit; shorten its source query before deployment.`);
  logger.info("Voice memory ready", { id: spec.id, characters: model.content.length, refreshed: model.last_refreshed_at });
}
const results = await Promise.allSettled(voiceMemoryModels.map(prepare));
for (const result of results)
  if (result.status === "rejected") {
    logger.error("Voice memory setup incomplete", { message: result.reason.message });
    process.exitCode = 1;
  }
