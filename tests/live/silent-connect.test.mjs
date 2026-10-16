// Fix 1 silent-connect regression (docs/evidence/fix1-regression.md): a prepared-memory refresh
// pushed into a call nobody had spoken in yet made the model say "Okay. Understood." The page now
// holds those quiet updates, and the call-start clock (the next early reply came right after it),
// until the user speaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryContext } from "../../web/memory-context.js";
import { ClockContext } from "../../web/clock-context.js";
import { VoiceMemory } from "../../src/live/memory.js";

const bridge = () => {
  const sent = [];
  const context = new MemoryContext((type, content) => {
    const id = `event-${sent.length}`;
    sent.push({ type, content, id });
    return [id];
  }, () => {}, { holdUntilUser: true });
  return { sent, context };
};

test("silent call: a memory refresh before the user speaks is not sent", () => {
  const { sent, context } = bridge();
  context.reset([{ id: "profile", revision: "old" }]);
  context.receive([{ id: "profile", revision: "new", context: "Refreshed facts" }]);
  context.flush(); // channel open / session started
  assert.equal(sent.length, 0);
});

test("the held refresh goes out once the user speaks, then the next waits again", () => {
  const { sent, context } = bridge();
  context.reset([{ id: "profile", revision: "old" }]);
  context.receive([{ id: "profile", revision: "new", context: "Refreshed facts" }]);
  context.userSpoke();
  assert.deepEqual(sent.map((e) => [e.type, e.content]), [["session.thinking.append", "Refreshed facts"]]);
  context.acknowledge(sent[0].id);
  context.receive([{ id: "profile", revision: "newer", context: "Later facts" }]);
  assert.equal(sent.length, 1, "a refresh during a quiet stretch waits for the user");
  context.userSpoke();
  assert.equal(sent.at(-1).content, "Later facts");
});

test("an unchanged section is not counted as held", () => {
  const { sent, context } = bridge();
  context.reset([{ id: "profile", revision: "same" }]);
  context.receive([{ id: "profile", revision: "same", context: "Same facts" }]);
  assert.equal(context.pending.size, 0);
  context.receive([{ id: "profile", revision: "changed", context: "Changed facts" }]);
  assert.equal(context.pending.size, 1);
  assert.equal(sent.length, 0);
});

test("a new session (reconnect included) holds again until the user speaks", () => {
  const { sent, context } = bridge();
  context.userSpoke();
  context.reset([{ id: "profile", revision: "a" }]);
  context.receive([{ id: "profile", revision: "b", context: "B" }]);
  assert.equal(sent.length, 0);
});

test("call start: the clock is held until the user speaks, then sends the newest minute", () => {
  const sent = [];
  let minute = "1";
  const clock = new ClockContext((type, content) => (sent.push(content), [`c${sent.length}`]), () => {},
    () => ({ id: "browser-clock", revision: minute, context: `Clock ${minute}` }), { holdUntilUser: true });
  clock.start();
  assert.deepEqual(sent, [], "nothing at call start: the prompt already has the start time");
  minute = "2";
  clock.refresh();
  assert.deepEqual(sent, [], "a minute change in a silent call waits too");
  clock.userSpoke();
  assert.deepEqual(sent, ["Clock 2"]);
  clock.stop();
});

test("without the option the clock still sends at once (existing clock behaviour)", () => {
  const sent = [];
  const clock = new ClockContext((type, content) => (sent.push(content), ["c"]), () => {},
    () => ({ id: "browser-clock", revision: "1", context: "Clock" }));
  clock.start();
  clock.stop();
  assert.deepEqual(sent, ["Clock"]);
});

test("the page holds memory updates and releases them on user speech", () => {
  const page = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  assert.match(page, /new MemoryContext\([^;]*\{ holdUntilUser: true \}\)/);
  assert.match(page, /record\("memory.context.held"/);
  assert.match(page, /new ClockContext\([^;]*\{ holdUntilUser: true \}\)/);
  // Held memory is no longer released on user speech (conversation fix, Oct 16): it waits for the
  // next session's prompt.
  assert.equal(page.match(/memoryContext\.userSpoke\(\)/g), null);
  // The held clock goes out only once a turn asks the time (conversation fix, Oct 16).
  const place = page.slice(page.indexOf("function placeTimes(text)"), page.indexOf("const delivery = new DeliveryPolicy()"));
  assert.match(place, /if \(!text \|\| !clockQuestion\(text\)\) return;\n\s*if \(placesSent\.turn !== turnTaking\.turn\) \{/);
  assert.match(place, /const localClock = \(tries\) => \{\n\s*if \(placesSent\.turn !== turn \|\| placesSent\.zones\.size\) return;\n\s*if \(PLACE_COMING\.test\(turn\?\.text \|\| ""\) && tries > 0\) placesSent\.timer = setTimeout\(\(\) => localClock\(tries - 1\), LOCAL_CLOCK_WAIT_MS\);\n\s*else clockContext\.userSpoke\(\);/);
  assert.match(place, /placesSent\.timer = setTimeout\(\(\) => localClock\(3\), LOCAL_CLOCK_WAIT_MS\);/);
  assert.match(page, /const LOCAL_CLOCK_WAIT_MS = 1000;/);
  // A named place gets its own short line and cancels the local clock.
  assert.match(place, /if \(!fresh\.length\) return;\n\s*clearTimeout\(placesSent\.timer\);/);
  // "what time it is in" waits for the place.
  const coming = new RegExp(page.match(/const PLACE_COMING = \/(.*)\/i;/)[1], "i");
  for (const t of [" What time it is in", "what time is it in,", "what's the time at"]) assert.ok(coming.test(t), t);
  for (const t of [" What time is it?", "what time it is in Tokyo"]) assert.ok(!coming.test(t), t);
  // Nowhere else: not at a turn's first words, not while the voice speaks.
  assert.equal(page.match(/clockContext\.userSpoke\(\)/g).length, 1, "nowhere else");
  assert.match(page, /clockContext\.reset\(\[clockSnapshot\(\)\]\);/);
});

test("each memory section says it is quiet context, not a cue to speak", () => {
  const memory = Object.create(VoiceMemory.prototype);
  memory.prepared = [{ id: "profile", content: "Facts", refreshed: "now" }];
  assert.match(memory.snapshot()[0].context, /Quiet context, not a request to speak: never reply to or acknowledge this update\./);
});
