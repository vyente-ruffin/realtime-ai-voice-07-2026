// M4.T5 — barge-in must not leave stale speech queued at the mouth.
//
// Regression: replies were spoken one question behind. The server drops a
// reply whose epoch went stale, but a reply already broadcast and queued in
// the browser survived barge-in and was flushed on the next response.done.
import assert from "node:assert/strict";
import test from "node:test";
import { dropPendingSpeech } from "../../src/background-turn.js";

test("barge-in clears every queued utterance", () => {
  const queue = ["answer to question 1", "answer to question 2"];
  assert.equal(dropPendingSpeech(queue), 2);
  assert.deepEqual(queue, []);
});

test("clearing an empty queue is a no-op", () => {
  const queue = [];
  assert.equal(dropPendingSpeech(queue), 0);
  assert.deepEqual(queue, []);
});

test("a non-array queue is rejected rather than silently ignored", () => {
  assert.throws(() => dropPendingSpeech(null), TypeError);
});

// The browser-side contract this mirrors: after barge-in, the next
// response.done must not resurrect a pre-interrupt answer.
test("flush after barge-in speaks nothing stale", () => {
  const queue = ["stale answer"];
  dropPendingSpeech(queue);
  const flushed = queue.length ? queue.shift() : null;
  assert.equal(flushed, null);
});
