/** Fix 4: honest status. The voice gets each task's name, state, minutes, newest Hermes
 * progress step and a plain failure reason, and a status rule that answers only from it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VoiceStore } from "../../src/live/store.js";
import { VoiceWorker, reasons, progressStep } from "../../src/live/worker.js";
import { instructions } from "../../src/live/policy.js";
import { statusContext, taskTitle, plainReason } from "../../web/status-context.js";
import { fakeHermes } from "./fake-hermes.mjs";

const root = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BANNED = /nothing solid yet|internal glitch|the system ran into|internal error/i;
async function until(fn, what, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await sleep(5);
  }
}
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fix4-"));
  const store = new VoiceStore(join(dir, "state.sqlite"));
  const hermes = fakeHermes(options);
  const updates = [];
  const worker = new VoiceWorker({
    store, key: "test-key", baseUrl: "http://hermes.test", fetch: hermes.fetch,
    onUpdate: (j) => updates.push(j), retryMs: 10, idleMs: 2000,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conversation = store.createConversation().id;
  const job = (d, said = `Request ${d}`) => store.enqueue(conversation, "call-1", d, `assistant: Hi.\nuser: ${said}`);
  return { store, hermes, worker, updates, conversation, job };
}

test("4a: a task is named from the user's request and its state and minutes match the job row", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a", "Research the history of the bicycle and write me a summary.");
  assert.equal(a.title, "Research the history of the bicycle and write me a summary.");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  const row = store.job(a.id);
  const at30s = statusContext([row], row.created + 30000);
  assert.match(at30s, /1 task is running now\./);
  assert.match(at30s, /"Research the history of the bicycle and write me a summary\.": running; started under a minute ago/);
  const at90s = statusContext([row], row.created + 90000);
  assert.match(at90s, /running; started 1 minute ago/);
  assert.notEqual(at30s, at90s, "a minute change is a change, so the context is sent again");
  hermes.complete("run_1", "The bicycle dates from 1817.");
  await done;
  const ended = store.job(a.id);
  const after = statusContext([ended], ended.updated + 1000);
  assert.match(after, /No task is running now\./);
  assert.match(after, /: finished; ran under a minute, ended under a minute ago/);
  assert.doesNotMatch(after, /1817/, "status never carries the result text (Fix 1)");
});

test("4a: task names are short and come from the newest user line", () => {
  assert.equal(taskTitle("user: first ask\nassistant: ok\nuser: Check the weather in Paris"), "Check the weather in Paris");
  const long = taskTitle(`user: ${"word ".repeat(40)}`);
  assert.ok(long.length <= 80, long);
});

test("4b: the newest tool.started or message.interim event becomes the task's latest step", async (t) => {
  const { store, hermes, worker, updates, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  hermes.event("run_1", { event: "tool.started", tool: "web_search", preview: "bicycle invention year" });
  await until(() => store.job(a.id).progress, "progress");
  assert.equal(store.job(a.id).progress, "searching the web (bicycle invention year)");
  assert.ok(updates.some((u) => u.progress === "searching the web (bicycle invention year)"), "the update is published");
  hermes.event("run_1", { event: "message.interim", text: "Found two sources, comparing them now." });
  await until(() => /comparing/.test(store.job(a.id).progress || ""), "interim");
  hermes.event("run_1", { event: "tool.started", tool: "_thinking", preview: "hidden" });
  hermes.event("run_1", { event: "tool.started", tool: "mcp_github_search_code", preview: "repo:x" });
  await until(() => /github/.test(store.job(a.id).progress || ""), "mcp tool");
  assert.equal(store.job(a.id).progress, "using the github search code tool (repo:x)");
  assert.match(statusContext([store.job(a.id)], Date.now()), /latest step: using the github search code tool \(repo:x\)/);
  hermes.complete("run_1", "done");
  await done;
  const before = store.job(a.id).progress;
  store.setProgress(a.id, "late");
  assert.equal(store.job(a.id).progress, before, "a finished task keeps its last step");
  assert.equal(progressStep({ event: "tool.started", tool: "_thinking" }), null);
});

test("4c: a run stopped through Hermes /stop is described as 'you cancelled it'", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  // Stopped from outside the app, exactly as the check does it.
  await hermes.fetch("http://hermes.test/v1/runs/run_1/stop", { method: "POST", body: "{}" });
  await done;
  const row = store.job(a.id);
  assert.equal(row.state, "cancelled");
  assert.equal(row.error, reasons.cancelled);
  const text = statusContext([row], row.updated + 5000);
  assert.match(text, /cancelled; .*reason: You cancelled it\./);
  assert.doesNotMatch(text, BANNED);
});

test("4c: a gateway restart is described as 'Hermes restarted'", async (t) => {
  const { store, hermes, worker, job } = setup(t);
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  hermes.state.down = true;
  hermes.restart();
  await sleep(40);
  hermes.state.down = false;
  await done;
  const text = statusContext([store.job(a.id)], Date.now());
  assert.match(text, /stopped part way; .*reason: Hermes restarted during this task/);
  assert.doesNotMatch(text, BANNED);
  assert.doesNotMatch(text, /Gateway shutdown/);
});

test("4c: a failed tool is named in plain words; busy and approval have their own plain words", async (t) => {
  const { store, hermes, worker, job } = setup(t, { cap: 1 });
  const a = job("a");
  const done = worker.kick();
  await until(() => store.job(a.id).run_id, "run id");
  const b = job("b");
  await worker.kick();
  assert.match(statusContext([store.job(b.id)], Date.now()), /reason: Hermes was busy/);
  hermes.event("run_1", { event: "approval.request", request_id: "r1", description: "Run rm -rf build", choices: ["once", "deny"] });
  await until(() => store.job(a.id).state === "awaiting_permission", "awaiting");
  const permissions = [...worker.permissions.values()].map((p) => ({ title: p.toolCall.title }));
  assert.match(statusContext([{ ...store.job(a.id), permissions }], Date.now()), /waiting for your approval; .*needs your approval for: Run rm -rf build/);
  await worker.answer(a.id, "r1", "once");
  hermes.event("run_1", { event: "tool.completed", tool: "web_extract", error: true, duration: 1 });
  const run = hermes.runs.get("run_1");
  run.status = "failed";
  run.error = "Internal error: provider 500";
  hermes.event("run_1", { event: "run.failed", error: run.error });
  await done;
  const text = statusContext([store.job(a.id)], Date.now());
  assert.match(text, /failed; .*reason: The web extract step failed, so Hermes could not finish this task\./);
  assert.doesNotMatch(text, BANNED);
});

test("4c: raw error text in an older job row is never passed to the voice", () => {
  const now = Date.now();
  for (const error of ["Internal error", "The system ran into an internal glitch", "TypeError: x is undefined", "HTTP 500"]) {
    const row = { id: "x", title: "Old task", state: "failed", error, created: now - 120000, updated: now - 60000 };
    assert.equal(plainReason(row), "Hermes could not finish it.");
    assert.doesNotMatch(statusContext([row], now), BANNED);
  }
});

test("4d: with no running job the context says so plainly, also at call start", () => {
  const now = Date.now();
  const ended = { id: "e", title: "Old one", state: "completed", created: now - 600000, updated: now - 300000 };
  assert.match(statusContext([], now), /No task is running now\.$/);
  assert.match(statusContext([ended], now), /No task is running now\./);
  const old = { ...ended, updated: now - 2 * 3600000 };
  assert.doesNotMatch(statusContext([old], now), /Old one/, "long-finished tasks are left out");
  const prompt = instructions("", [ended], {});
  assert.match(prompt, /Task status at the start of this call[^\n]*\nTask status from the app[^\n]*No task is running now\./);
});

test("4e: the status rule bans the vague phrases and answers only from the task status", () => {
  const prompt = instructions("", [], {});
  assert.match(prompt, /Status policy: /);
  assert.match(prompt, /for an ended task say its reason as written there, for example "You cancelled it" or "Hermes restarted during this task"/);
  assert.match(prompt, /never announce a task's progress, elapsed time or state on your own/);
  assert.match(statusContext([], Date.now()), /silent update, not a request to speak/);
  assert.match(prompt, /answer only from the newest task status/);
  assert.match(prompt, /When it says no task is running, say plainly that nothing is running\./);
  assert.match(prompt, /Never answer status from memory, the earlier conversation or a guess/);
  assert.match(prompt, /never use vague phrases such as "nothing solid yet", "internal glitch", "the system ran into"/);
  for (const r of Object.values(reasons)) assert.doesNotMatch(typeof r === "function" ? r("terminal") : r, BANNED);
});

test("4a/4b: the browser sends the status context on every change and refreshes the minutes when the user starts speaking", () => {
  const live = readFileSync(join(root, "web/live.js"), "utf8");
  const server = readFileSync(join(root, "src/live/server.js"), "utf8");
  assert.match(live, /import \{ statusContext, plainReason \} from "\.\/status-context\.js"/);
  assert.match(live, /A background task ended and is no longer running\. Tell the user its result briefly at a natural pause, once: \$\{plainReason\(job\)\}/, "an ended task's delivery never sounds like it is still running, and never carries raw error text");
  assert.match(live, /statusContext\(\[\.\.\.jobs\.values\(\)\], Date\.now\(\)\)/);
  assert.match(live, /append\("session\.thinking\.append", snapshot\)/);
  assert.match(live, /delivery\.heard\(now\);\n\s*if \(now - statusCheckedAt > 2000\) quietJobs\(\);/, "minutes are current when the user asks");
  assert.doesNotMatch(live, /setInterval\(quietJobs/, "no timed resend: it made the model announce progress unasked");
  assert.doesNotMatch(live, /if \(!session \|\| !jobs\.size\) return;/, "an empty job list still says nothing is running");
  assert.match(live, /updateJob[\s\S]*quietJobs\(\)/, "every job change is sent");
  assert.match(server, /"\/web\/status-context\.js"/);
  assert.match(server, /\.update\(statusScript\)/);
});

test("4a: each task line stays well inside the 500-token quiet-context cap", () => {
  const now = Date.now();
  const jobs = Array.from({ length: 10 }, (_, i) => ({
    id: String(i), title: "x".repeat(300), state: "running", progress: "y".repeat(500), created: now - i * 60000, updated: now,
  }));
  const text = statusContext(jobs, now);
  assert.ok(text.length < 1500, `${text.length} characters`);
  assert.equal(text.split("\n").length, 5, "header plus at most four tasks");
  assert.match(text, /10 tasks are running now\./);
});
