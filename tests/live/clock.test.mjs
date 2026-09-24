import { test } from "node:test";
import assert from "node:assert/strict";
import { ClockContext, clockSnapshot } from "../../web/clock-context.js";

function fixture(t) {
  let now = new Date("2026-09-24T23:59:50Z"), zone = "UTC";
  const sent = [], accepted = [];
  const clock = new ClockContext((type, content) => {
    const id = `clock-${sent.length}`;
    sent.push({ type, content, id });
    return [id];
  }, value => accepted.push(value), () => clockSnapshot(now, zone));
  t.after(() => clock.stop());
  return { clock, sent, accepted, time: value => { now = new Date(value); }, zone: value => { zone = value; } };
}

test("browser clock updates the date across midnight and the zone during a call", t => {
  const f = fixture(t);
  f.clock.start();
  assert.match(f.sent[0].content, /Thursday, September 24, 2026 at 11:59 PM/);
  assert.equal(f.sent[0].type, "session.thinking.append");
  f.clock.acknowledge(f.sent[0].id);
  f.clock.refresh();
  assert.equal(f.sent.length, 1);
  f.time("2026-09-25T00:00:01Z");
  f.clock.refresh();
  assert.match(f.sent[1].content, /Friday, September 25, 2026 at 12:00 AM/);
  f.clock.acknowledge(f.sent[1].id);
  f.zone("America/Los_Angeles");
  f.clock.refresh();
  assert.match(f.sent[2].content, /Thursday, September 24, 2026 at 5:00 PM/);
  assert.match(f.sent[2].content, /America\/Los_Angeles/);
});

test("clock sends only changed minutes and catches up after the browser pauses", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(t);
  f.clock.start();
  f.clock.acknowledge(f.sent[0].id);
  t.mock.timers.tick(5000);
  assert.equal(f.sent.length, 1);
  f.time("2026-09-25T00:04:05Z");
  t.mock.timers.tick(1000);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].content, /12:04 AM/);
  f.clock.acknowledge(f.sent[1].id);
  f.clock.start();
  assert.equal(f.sent.length, 2);
});

test("rejected or unacknowledged clock updates cannot freeze the clock", t => {
  const f = fixture(t);
  f.clock.start();
  f.clock.reject(f.sent[0].id);
  f.clock.refresh();
  assert.equal(f.sent.length, 2);
  f.time("2026-09-25T00:00:01Z");
  f.clock.refresh();
  assert.equal(f.sent.length, 3);
  f.clock.acknowledge(f.sent[1].id);
  assert.equal(f.accepted.length, 0);
  f.clock.acknowledge(f.sent[2].id);
  assert.equal(f.accepted.length, 1);
});

test("stopping removes clock state and reconnect loads a fresh snapshot", t => {
  const f = fixture(t);
  f.clock.start();
  f.clock.stop();
  f.clock.refresh();
  f.clock.acknowledge(f.sent[0].id);
  assert.equal(f.sent.length, 1);
  assert.equal(f.accepted.length, 0);
  f.time("2026-09-25T00:02:00Z");
  f.clock.start();
  assert.match(f.sent[1].content, /12:02 AM/);
});

test("browser clock uses the selected zone through daylight-saving transitions", () => {
  const before = clockSnapshot(new Date("2026-11-01T08:59:00Z"), "America/Los_Angeles");
  const after = clockSnapshot(new Date("2026-11-01T09:00:00Z"), "America/Los_Angeles");
  assert.match(before.context, /1:59 AM/);
  assert.match(after.context, /1:00 AM/);
  assert.notEqual(before.revision, after.revision);
});
