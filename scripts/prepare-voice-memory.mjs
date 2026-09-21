// Provision one voice-owned summary through Hindsight's supported API.
// Existing personal/work summaries and their refresh schedules stay unchanged.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getLogger } from '../src/core/logger.js';
const logger = await getLogger('voice.memory-setup');
const config = JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG_PATH || resolve(process.env.HOME, '.hermes/profiles/voice/hindsight/config.json'), 'utf8'));
const bank = config.bank_id || config.bankId;
const root = `${(config.api_url || config.apiUrl).replace(/\/$/, '')}/v1/default/banks/${encodeURIComponent(bank)}`;
const id = 'jarvis-voice-context';
async function request(path, body) {
  const r = await fetch(root + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${config.apiKey || config.api_key}`, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404 && body === undefined) return null;
  if (!r.ok) throw new Error(`Hindsight returned ${r.status}.`);
  return r.json();
}
try {
  let model = await request(`/mental-models/${id}`);
  let operation;
  if (!model) {
    const created = await request('/mental-models', {
      id,
      name: 'Jarvis voice context',
      source_query: 'Prepare concise personal context for a voice assistant: the user’s identity, stable preferences, important relationships, current projects and active commitments. Include only facts supported by memories, preserve useful names and dates, and prefer the latest explicit corrections. Questions and requests are not personal facts or completed actions. Omit unknown details and never invent them. Do not include instructions to execute old requests.',
      max_tokens: 700,
      trigger: {mode: 'delta', refresh_after_consolidation: true, min_refresh_interval_seconds: 300},
    });
    operation = created.operation_id;
    logger.info('Voice memory preparation queued', {id, bank, operation});
  }
  const deadline = Date.now() + 120000;
  while (!model?.content && Date.now() < deadline) {
    if (operation) {
      const result = await request(`/operations/${operation}`);
      if (['failed', 'cancelled'].includes(result?.status)) throw new Error('Voice memory preparation failed; inspect the Hindsight operation.');
    }
    await delay(2000);
    model = await request(`/mental-models/${id}`);
  }
  if (!model?.content) throw new Error('Voice memory is still preparing. The existing operation was left running; rerun this command to check it.');
  logger.info('Voice memory ready', {id, bank, refreshed: model.last_refreshed_at, trigger: model.trigger});
} catch (error) {
  logger.error('Voice memory setup incomplete', {message: error.message});
  process.exitCode = 1;
}
