import test from "node:test";
import assert from "node:assert/strict";
import { instructions, workerPrompt } from "../../src/live/policy.js";

// Check the actual prompt-producing seams, not source layout. Real model behavior
// is separately evidenced by the bounded native Hermes probe in the ledger.
test("speech and worker prompts share task authorization without removing gates", () => {
  for (const prompt of [instructions("", []), workerPrompt({ request: "Benign task" }, [], [])]) {
    assert.match(prompt, /accepted task authorizes/i);
    assert.match(prompt, /original task authorization and boundaries/);
    assert.match(prompt, /new spending/);
    assert.match(prompt, /unrequested irreversible loss/);
    assert.match(prompt, /explicit release gate/);
    assert.match(prompt, /runtime denial stays binding/);
    assert.match(prompt, /capacity limits need engineering correction/);
    assert.match(prompt, /running lookup is not proof its subject task is running/);
  }
});
