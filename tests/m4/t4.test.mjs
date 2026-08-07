import assert from "node:assert/strict";
import test from "node:test";
import { PromptLane, waitForCancellation } from "../../src/acp-client.js";
import {
  answerProvenanceForQuestion,
  cancellationNeedsReplacement,
  formatTaskReceipt,
  normalizeProvenance,
  provenanceForTurnPayload,
  shouldBootstrapBrain,
  shouldDetachAtBoundary,
  splitAtThreshold,
  taskHandleForSession,
} from "../../src/background-turn.js";

const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

test("quick work stays on the foreground reply path", async () => {
  const result = await splitAtThreshold(Promise.resolve({ text: "fast" }), 50);
  assert.equal(result.background, false);
  assert.deepEqual(result.value, { text: "fast" });
  assert.equal(result.continuation, null);
});

test("slow work yields a receipt boundary while the same real work continues", async () => {
  const started = performance.now();
  const result = await splitAtThreshold(sleep(80, { text: "final answer" }), 15);
  const elapsed = performance.now() - started;

  assert.equal(result.background, true);
  assert.equal(result.value, null);
  assert.ok(elapsed < 60, `handoff took ${elapsed}ms`);
  assert.deepEqual(await result.continuation, { text: "final answer" });
});

test("a background failure remains observable on the continuation path", async () => {
  const work = new Promise((_, reject) => setTimeout(() => reject(new Error("boom")), 40));
  const result = await splitAtThreshold(work, 10);

  assert.equal(result.background, true);
  await assert.rejects(result.continuation, /boom/);
});

test("a prompt lane is reserved synchronously and released after settlement", async () => {
  const lane = new PromptLane();
  let finish;
  const work = new Promise((resolve) => { finish = resolve; });

  assert.equal(lane.isBusy(), false);
  const tracked = lane.track(work);
  assert.equal(lane.isBusy(), true);
  finish("done");
  assert.equal(await tracked, "done");
  assert.equal(lane.isBusy(), false);
});

test("a failed prompt also releases its lane", async () => {
  const lane = new PromptLane();
  const tracked = lane.track(Promise.reject(new Error("lane-failure")));
  assert.equal(lane.isBusy(), true);
  await assert.rejects(tracked, /lane-failure/);
  assert.equal(lane.isBusy(), false);
});

test("invalid thresholds fail closed", async () => {
  await assert.rejects(splitAtThreshold(Promise.resolve("x"), -1), /thresholdMs/);
  await assert.rejects(splitAtThreshold(Promise.resolve("x"), Number.NaN), /thresholdMs/);
});

test("spoken long-task receipt includes the real handle", () => {
  assert.equal(
    formatTaskReceipt("voice-48e565d6"),
    "Starting that now. Task handle voice-48e565d6."
  );
});

test("application task handle maps deterministically to the full ACP session", () => {
  assert.equal(
    taskHandleForSession("48e565d6-ffb3-4c61-a26a-58c0fa5bf29e"),
    "voice-48e565d6"
  );
});

test("provenance accepts declared labels and fails unknown input closed", () => {
  assert.equal(normalizeProvenance("synthetic test input"), "synthetic test input");
  assert.equal(normalizeProvenance("user-authored/app-transcribed"), "user-authored/app-transcribed");
  assert.equal(normalizeProvenance("pretend-v-spoke-this"), "unknown/needs review");
});

test("cancellation reports the ACP cancelled stop reason", async () => {
  const result = await waitForCancellation(
    Promise.resolve({ text: "", stopReason: "cancelled", ms: 25 }),
    100
  );
  assert.deepEqual(result, { completed: true, stopReason: "cancelled", error: null });
});

test("cancellation wait is bounded so a stuck worker can be replaced", async () => {
  const never = new Promise(() => {});
  const started = performance.now();
  const result = await waitForCancellation(never, 15);
  assert.equal(result.completed, false);
  assert.equal(result.stopReason, "timeout");
  assert.ok(performance.now() - started < 80);
});

test("only a confirmed ACP cancelled stop reason keeps the worker", () => {
  assert.equal(cancellationNeedsReplacement({ sent: true, completed: true, stopReason: "cancelled" }), false);
  assert.equal(cancellationNeedsReplacement({ sent: true, completed: false, stopReason: "timeout" }), true);
  assert.equal(cancellationNeedsReplacement({ sent: true, completed: true, stopReason: "end_turn" }), true);
  assert.equal(cancellationNeedsReplacement({ sent: true, completed: true, stopReason: "error" }), true);
});

test("missing or invalid turn provenance fails closed", () => {
  assert.equal(provenanceForTurnPayload("user-authored/app-transcribed"), "user-authored/app-transcribed");
  assert.equal(provenanceForTurnPayload("synthetic test input"), "synthetic test input");
  assert.equal(provenanceForTurnPayload(undefined), "unknown/needs review");
  assert.equal(provenanceForTurnPayload("pretend-v-spoke-this"), "unknown/needs review");
});

test("synthetic input produces synthetic output provenance", () => {
  assert.equal(answerProvenanceForQuestion("synthetic test input"), "synthetic test output");
  assert.equal(answerProvenanceForQuestion("user-authored/app-transcribed"), "assistant-authored");
  assert.equal(answerProvenanceForQuestion("unknown/needs review"), "assistant-authored");
});

test("barge-in at or beyond the response boundary detaches instead of cancelling", () => {
  assert.equal(shouldDetachAtBoundary(1_000, 15_999, 15_000), false);
  assert.equal(shouldDetachAtBoundary(1_000, 16_000, 15_000), true);
  assert.equal(shouldDetachAtBoundary(1_000, 20_000, 15_000), true);
});

test("replacement brains skip bootstrap so concurrent speech keeps the SLA", () => {
  assert.equal(shouldBootstrapBrain("boot"), true);
  assert.equal(shouldBootstrapBrain("between-turn-recovery"), true);
  assert.equal(shouldBootstrapBrain("background-replacement"), false);
  assert.equal(shouldBootstrapBrain("cancellation-replacement"), false);
});
