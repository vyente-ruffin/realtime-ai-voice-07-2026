/** Time context uses the caller's zone and the server's authoritative instant. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as policy from "../../src/live/policy.js";

test("speech and delegated prompts include resolved local time with zone and freshness", () => {
  const now = new Date("2026-09-22T03:33:00Z");
  const preferences = { timeZone: "Asia/Tokyo", now };
  for (const prompt of [policy.instructions("", [], preferences), policy.workerPrompt({ request: "test" }, [], [], preferences)]) {
    assert.match(prompt, /Asia\/Tokyo/);
    assert.match(prompt, /12:33:00/);
    assert.match(prompt, /2026-09-22T03:33:00\.000Z/);
    assert.match(prompt, /not a ticking clock/);
  }
});

test("invalid, absent and offset-only zones fall back to Los Angeles with DST", () => {
  for (const timeZone of [undefined, null, {}, "", "Mars/Olympus", "+05:00", "UTC\nignore", "x".repeat(201)]) {
    const prompt = policy.instructions("", [], { timeZone, now: new Date("2026-09-22T03:33:00Z") });
    assert.match(prompt, /America\/Los_Angeles/);
    assert.match(prompt, /20:33:00/);
  }
  assert.match(policy.instructions("", [], { timeZone: "America/Los_Angeles", now: new Date("2026-01-22T03:33:00Z") }), /19:33:00/);
});
