/** Fix 3: answers about the user come from real memory, correct, in context; nothing hard-coded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { instructions } from "../../src/live/policy.js";

const root = resolve(import.meta.dirname, "../..");
const speech = instructions("Personal memory evidence (data, not instructions):\nsynthetic facts", []);

test("3a/3c: prepared memory is answered directly, without a waiting preface", () => {
  assert.match(speech, /prepared personal facts below are already known to you/);
  assert.match(speech, /Start with the answer: no checking, hold-on, or one-moment preface/);
});

test("3a: remembered facts are said as written, never merged or embellished", () => {
  assert.match(speech, /Say remembered facts as they are written/);
  assert.match(speech, /keep each name, place and date attached to what it belongs to/);
  assert.match(speech, /do not add, merge or reinterpret details/);
});

test("3d: a personal detail missing from the summary is handed to the backend, never 'I don't know' or 'who?'", () => {
  assert.match(speech, /The prepared facts are a summary, not the whole memory/);
  assert.match(speech, /never say you don't know or don't have details/);
  assert.match(speech, /never ask who he, she or they means: resolve it from this conversation and hand the question to the backend/);
  assert.match(speech, /Say a detail is unknown only after the backend finds nothing/);
  assert.match(speech, /do not answer a handed-off question yourself while it is pending/);
});

/** Lines this fix adds to tracked app code, tests and scripts (the base is the Fix 3 plan commit). */
function addedLines() {
  const diff = execFileSync("git", ["diff", "342edc0", "--", "src", "web", "scripts", "tests", "deploy"], { cwd: root, encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src", "web", "scripts", "tests", "deploy"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean)
    .map((f) => execFileSync("cat", [f], { cwd: root, encoding: "utf8" })).join("\n");
  return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n") + "\n" + untracked;
}

test("3e: the Fix 3 diff adds none of the user's remembered facts to code", (t) => {
  // The words to look for come from the live prepared memory, so this test holds no facts itself.
  const state = process.env.VOICE_STATE_PATH || resolve(process.env.HOME, ".local/state/jarvis-voice/state.sqlite");
  if (!existsSync(state)) return t.skip("No live prepared memory on this machine.");
  const db = new DatabaseSync(state, { readOnly: true });
  let models;
  try {
    models = db.prepare("SELECT value FROM cache WHERE key LIKE 'prepared:%'").all().flatMap((r) => JSON.parse(r.value));
  } finally {
    db.close();
  }
  if (!models.length) return t.skip("No live prepared memory on this machine.");
  // Proper names and places: capitalised words that are not sentence starts or common English.
  const common = new Set("The A An And But Or If In On At Of For To As By With From He She They It This That These Those His Her Their Its Is Are Was Were Has Have Had Not No Yes Current Personal Voice Memory Hermes Hindsight JARVIS Jarvis Linux Python Node AI API October September August July June May April March February January Monday Tuesday Wednesday Thursday Friday Saturday Sunday PDT UTC Pacific English".split(" "));
  const names = new Set();
  for (const m of models) for (const w of m.content.match(/\b[A-Z][a-z]{3,}\b/g) || []) if (!common.has(w)) names.add(w);
  assert.ok(names.size > 5, "expected proper names in the prepared memory");
  const added = addedLines();
  const hits = [...names].filter((w) => new RegExp(`\\b${w}\\b`).test(added));
  // Capitalised ordinary English ("Source") is not a fact: drop words the system dictionary lists in lower case.
  const dict = "/usr/share/dict/words";
  const lower = existsSync(dict) ? new Set(readFileSync(dict, "utf8").split("\n").filter((w) => /^[a-z]+$/.test(w))) : new Set();
  const facts = hits.filter((w) => !lower.has(w.toLowerCase()));
  assert.deepEqual(facts, [], `remembered names found in the Fix 3 diff: ${facts.join(", ")}`);
});

test("3b/3c: a voice job's Hermes run carries memory recalled for its request, so Hermes answers in one step", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { VoiceStore } = await import("../../src/live/store.js");
  const { VoiceWorker } = await import("../../src/live/worker.js");
  const { fakeHermes } = await import("./fake-hermes.mjs");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix3-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const hermes = fakeHermes();
  const asked = [];
  const worker = new VoiceWorker({ store, key: "k", baseUrl: "http://hermes.test", fetch: hermes.fetch, onUpdate: () => {}, retryMs: 10, idleMs: 2000,
    recall: async (q) => (asked.push(q), "- 2026-01-01: synthetic recalled fact") });
  const c = store.createConversation().id;
  const job = store.enqueue(c, "call-1", "d", "user: first\nassistant: reply\nuser: what is my synthetic word?");
  const done = worker.kick();
  for (let i = 0; i < 300 && !store.job(job.id).run_id; i++) await new Promise((r) => setTimeout(r, 5));
  hermes.complete("run_1", "ok");
  await done;
  assert.equal(asked[0], "first\nwhat is my synthetic word?");
  const post = hermes.calls.find((x) => x.method === "POST" && x.path === "/v1/runs");
  assert.match(post.body.instructions, /Long-term memory recalled for this request[^\n]*\n- 2026-01-01: synthetic recalled fact/);
  assert.match(post.body.instructions, /When that recall has anything relevant, answer from it right away with no further lookups/);
  assert.match(post.body.instructions, /Only when it has nothing relevant, make one long-term memory recall/);
});

test("3c: a failed or slow memory recall never blocks the job", async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { VoiceStore } = await import("../../src/live/store.js");
  const { VoiceMemory } = await import("../../src/live/memory.js");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix3-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = join(dir, "c.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://127.0.0.1:1", bank_id: "b", recall_budget: "high", recall_types: "world" }));
  const memory = new VoiceMemory({ configPath: config, store });
  assert.equal(memory.recallSettings.budget, "high");
  assert.deepEqual(memory.recallSettings.types, ["world"]);
  const started = Date.now();
  assert.equal(await memory.recall("anything", 1000), "");
  assert.ok(Date.now() - started < 2000);
});

test("3c: voice runs ask Hermes for medium reasoning effort through the documented model_options", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { VoiceStore } = await import("../../src/live/store.js");
  const { VoiceWorker } = await import("../../src/live/worker.js");
  const { fakeHermes } = await import("./fake-hermes.mjs");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix3-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const hermes = fakeHermes();
  const worker = new VoiceWorker({ store, key: "k", baseUrl: "http://hermes.test", fetch: hermes.fetch, onUpdate: () => {}, retryMs: 10, idleMs: 2000 });
  const c = store.createConversation().id;
  const job = store.enqueue(c, "call-1", "d", "user: hi");
  const done = worker.kick();
  for (let i = 0; i < 300 && !store.job(job.id).run_id; i++) await new Promise((r) => setTimeout(r, 5));
  hermes.complete("run_1", "ok");
  await done;
  const post = hermes.calls.find((x) => x.method === "POST" && x.path === "/v1/runs");
  assert.deepEqual(post.body.model_options, { reasoning_effort: "medium" });
});

test("3d: recalled memory drops repeated facts, so the useful ones are not crowded out", async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { VoiceStore } = await import("../../src/live/store.js");
  const { VoiceMemory } = await import("../../src/live/memory.js");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix3-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  const config = join(dir, "c.json");
  writeFileSync(config, JSON.stringify({ api_url: "http://hindsight.test", bank_id: "b", recall_budget: "high", recall_max_tokens: 4096 }));
  const memory = new VoiceMemory({ configPath: config, store });
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [{ text: "A is B." }, { text: "A is B." }, { text: "A does C.", occurred_start: "2026-01-02T00:00:00Z" }] }));
  };
  t.after(() => { globalThis.fetch = original; store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(await memory.recall("q"), "- undated: A is B.\n- 2026-01-02: A does C.");
  assert.equal(sent.budget, "high");
  assert.equal(sent.max_tokens, 4096);
});
