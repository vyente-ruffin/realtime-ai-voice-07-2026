// Remove every memory a live test run created, with Hindsight's documented curation call
// (PATCH /memories/{id} {state:"invalidated"}: soft-retired, excluded from recall, derived
// observations pruned, reversible). Nothing is deleted. Sources of test memories:
//   - Hermes runs of the run's test conversations (document id = Hermes session id, tag session:<id>)
//   - `hermes -z` sessions started from the run's own working directory (see hermesOneshot)
//   - voice memory saves of the run's test conversations (document id voice-<retention id>;
//     the app skips these for test conversations, so this should always find 0)
//   - any memory created during the run whose text holds one of the run's unique test words
// Usage: node scripts/live-e2e/cleanup.mjs <run> [--since <ms>] [--word <w>]...
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { statePath } from "./harness.mjs";

const config = JSON.parse(readFileSync(resolve(process.env.HOME, ".hermes/hindsight/config.json"), "utf8"));
const bank = `${config.api_url.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(config.bank_id)}`;
const hermesState = resolve(process.env.HOME, ".hermes/state.db");

async function hindsight(path, { method = "GET", body } = {}) {
  const r = await fetch(bank + path, {
    method,
    headers: { Authorization: `Bearer ${config.api_key || config.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Hindsight ${method} ${path} returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function list(params) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const q = new URLSearchParams({ ...params, limit: "100", offset: String(offset) });
    const page = await hindsight(`/memories/list?${q}`);
    out.push(...page.items);
    if (page.items.length < 100) return out;
  }
}

/** Working directory for this run's `hermes -z` calls, so cleanup can find their sessions. */
export function oneshotDir(run) {
  const dir = resolve(tmpdir(), `jarvis-e2e-${run}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
/** Tell the main profile something with `hermes -z`, from this run's own directory. */
export function hermesOneshot(run, prompt) {
  return execFileSync("hermes", ["-z", prompt], { cwd: oneshotDir(run), encoding: "utf8", timeout: 300000 }).trim();
}

/** Hermes sessions (plus compression/delegation children) that belong to this test run. */
function hermesSessions(run, conversations) {
  const voice = new DatabaseSync(statePath, { readOnly: true });
  let roots, saves;
  try {
    roots = voice
      .prepare(`SELECT DISTINCT hermes_session AS id FROM jobs WHERE hermes_session IS NOT NULL AND conversation IN (${conversations.map(() => "?").join(",") || "NULL"})`)
      .all(...conversations)
      .map((r) => r.id);
    saves = voice
      .prepare(`SELECT id FROM retention WHERE conversation IN (${conversations.map(() => "?").join(",") || "NULL"})`)
      .all(...conversations)
      .map((r) => `voice-${r.id}`);
  } finally {
    voice.close();
  }
  const h = new DatabaseSync(hermesState, { readOnly: true });
  try {
    const dir = resolve(tmpdir(), `jarvis-e2e-${run}`);
    const oneshot = h.prepare("SELECT id FROM sessions WHERE cwd=? OR cwd LIKE ?").all(dir, `${dir}/%`).map((r) => r.id);
    const all = new Set([...roots, ...oneshot]);
    // Children (compression rotation, delegated subagents) carry the run's facts too.
    for (let grew = true; grew; ) {
      grew = false;
      const ids = [...all];
      for (const r of h.prepare(`SELECT id FROM sessions WHERE parent_session_id IN (${ids.map(() => "?").join(",") || "NULL"})`).all(...ids))
        if (!all.has(r.id)) all.add(r.id), (grew = true);
    }
    return { voiceRuns: roots, oneshot, sessions: [...all], saves };
  } finally {
    h.close();
  }
}

export async function cleanup({ run, since = 0, words = [], extraSessions = [] }) {
  const voice = new DatabaseSync(statePath, { readOnly: true });
  let conversations;
  try {
    conversations = voice.prepare("SELECT id FROM conversations WHERE test=?").all(run).map((r) => r.id);
  } finally {
    voice.close();
  }
  const found = hermesSessions(run, conversations);
  found.sessions.push(...extraSessions);
  // Hermes retains after each turn and Hindsight extracts facts in the background:
  // wait until no retain for the run's documents is still pending, so none lands after cleanup.
  const documents = new Set([...found.sessions, ...found.saves]);
  const pendingFor = async () => {
    let n = 0;
    for (const status of ["pending", "processing"]) {
      const ops = [];
      for (let offset = 0; ; offset += 100) {
        const page = await hindsight(`/operations?status=${status}&limit=100&offset=${offset}`);
        ops.push(...(page.operations || []));
        if ((page.operations || []).length < 100) break;
      }
      n += ops.filter((o) => o.document_id && [...documents].some((d) => o.document_id === d || o.document_id.startsWith(`${d}-`))).length;
    }
    return n;
  };
  const settleEnd = Date.now() + 10 * 60000;
  let pending;
  while ((pending = await pendingFor()) && Date.now() < settleEnd) await new Promise((r) => setTimeout(r, 10000));
  const targets = new Map();
  const add = (source, items) => {
    for (const m of items) if (!targets.has(m.id)) targets.set(m.id, { ...m, source });
  };
  for (const s of found.sessions) {
    add("hermes-session", await list({ document_id: s }));
    add("hermes-session", await list({ tags: `session:${s}` }));
    add("hermes-session", await list({ tags: `parent:${s}` }));
  }
  for (const d of found.saves) add("voice-save", await list({ document_id: d }));
  const start = new Date(since || Date.now() - 3600000).toISOString();
  for (const w of words) add("test-word", (await list({ q: w, start_date: start })).filter((m) => m.text?.toLowerCase().includes(w.toLowerCase())));
  let invalidated = 0, pruned = 0;
  // Source facts first: invalidating them prunes their derived observations, which then 404.
  const ordered = [...targets.values()].sort((a, b) => (a.fact_type === "observation") - (b.fact_type === "observation"));
  for (const m of ordered) {
    try {
      await hindsight(`/memories/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { state: "invalidated", reason: `voice live test run ${run}` } });
      invalidated++;
    } catch (err) {
      if (!/ returned 404/.test(err.message)) throw err;
      pruned++;
    }
  }
  const bySource = {};
  for (const m of targets.values()) bySource[m.source] = (bySource[m.source] || 0) + 1;
  // Proof: nothing from the run is still recallable.
  const recall = {};
  for (const w of words) {
    const r = await hindsight("/memories/recall", { method: "POST", body: { query: w, budget: "mid", max_tokens: 2048 } });
    recall[w] = (r.results || []).filter((x) => x.text?.toLowerCase().includes(w.toLowerCase())).length;
  }
  const remaining = {};
  for (const s of found.sessions) remaining[s] = (await list({ document_id: s })).length + (await list({ tags: `session:${s}` })).length;
  // Prepared voice memory is built from the bank: it must not hold any test word either.
  const models = (process.env.VOICE_MEMORY_MODELS || "jarvis-voice-profile,jarvis-voice-preferences,jarvis-voice-current").split(",");
  const hitsIn = async (id) => {
    const m = await hindsight(`/mental-models/${encodeURIComponent(id)}`).catch(() => null);
    return words.filter((w) => m?.content?.toLowerCase().includes(w.toLowerCase()));
  };
  const modelHits = {}, refreshed = [];
  for (const id of models) {
    modelHits[id] = await hitsIn(id);
    if (!modelHits[id].length) continue;
    // A summary refreshed while test facts were valid: rebuild it from the cleaned bank (documented refresh).
    await hindsight(`/mental-models/${encodeURIComponent(id)}/refresh`, { method: "POST", body: {} });
    refreshed.push(id);
    const end = Date.now() + 5 * 60000;
    while ((modelHits[id] = await hitsIn(id)).length && Date.now() < end) await new Promise((r) => setTimeout(r, 10000));
  }
  // Hermes's built-in memory files are not Hindsight; a test word there is reported, never edited here.
  const hermesMemoryFileHits = [];
  for (const f of ["MEMORY.md", "USER.md"]) {
    let text = "";
    try {
      text = readFileSync(resolve(process.env.HOME, ".hermes/memories", f), "utf8").toLowerCase();
    } catch {}
    for (const w of words) if (text.includes(w.toLowerCase())) hermesMemoryFileHits.push(`${f}:${w}`);
  }
  const report = {
    run,
    testConversations: conversations.length,
    hermesSessions: found.sessions,
    oneshotSessions: found.oneshot.length,
    voiceSaveDocuments: found.saves.length,
    memoriesFound: targets.size,
    bySource,
    invalidated,
    prunedWithTheirSource: pruned,
    stillValidPerSession: remaining,
    retainsStillPending: pending,
    recallHitsForTestWords: recall,
    preparedMemoryRefreshed: refreshed,
    hermesMemoryFileHits,
    preparedMemoryHitsForTestWords: modelHits,
  };
  console.log(`[cleanup] ${JSON.stringify(report)}`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const run = args[0];
  if (!run) throw new Error("Usage: cleanup.mjs <run> [--since ms] [--word w]...");
  const words = [], extraSessions = [];
  let since = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--word") words.push(args[++i]);
    else if (args[i] === "--since") since = Number(args[++i]);
    else if (args[i] === "--session") extraSessions.push(args[++i]);
  }
  await cleanup({ run, since, words, extraSessions });
}
