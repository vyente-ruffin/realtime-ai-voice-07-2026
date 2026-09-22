/** Deterministic browser telemetry tests: real module, injected transport/peer boundaries. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("audio summary uses inbound audio and selected-pair RTT, never remote/video counters", async () => {
  const { summarizeAudio } = await import("../../web/telemetry.js");
  const report = new Map([
    ["audio", { type: "inbound-rtp", kind: "audio", packetsReceived: 8, bytesReceived: 960, jitter: 0.012 }],
    ["video", { type: "inbound-rtp", kind: "video", packetsReceived: 9000, bytesReceived: 900000 }],
    ["remote", { type: "remote-inbound-rtp", kind: "audio", packetsReceived: 500 }],
    ["transport", { type: "transport", selectedCandidatePairId: "selected" }],
    ["selected", { type: "candidate-pair", currentRoundTripTime: 0.025 }],
    ["other", { type: "candidate-pair", currentRoundTripTime: 5 }],
  ]);
  assert.deepEqual(summarizeAudio(report), {
    packetsReceived: 8, bytesReceived: 960, jitterSeconds: 0.012, roundTripTimeSeconds: 0.025,
  });
  assert.deepEqual(summarizeAudio(new Map()), {
    packetsReceived: 0, bytesReceived: 0, jitterSeconds: null, roundTripTimeSeconds: null,
  });
});

test("a silent close flushes final stats and reason under its original call/session", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  const sent = [];
  const telemetry = new BrowserTelemetry({ post: async body => sent.push(body), beacon: () => false });
  const call = telemetry.begin("conversation-1");
  telemetry.bind(call, "live-1");
  call.peer = { getStats: async () => new Map(), connectionState: "connected", iceConnectionState: "connected" };
  call.channel = { readyState: "closed" };
  telemetry.record(call, "connection.open");
  await telemetry.end(call, "remote_channel_closed", false);
  await telemetry.flush();
  const ended = sent.flatMap(x => x.events).find(x => x.type === "call.ended");
  assert.equal(ended.session, "live-1");
  assert.equal(ended.conversation, "conversation-1");
  assert.equal(ended.callId, call.id);
  assert.equal(ended.detail.audioReceived, false);
  assert.equal(ended.detail.bytesReceived, 0);
  assert.equal(ended.detail.reason, "remote_channel_closed");
});

test("failed telemetry is bounded and retried; beacon is only queued, not acknowledged", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  let fail = true;
  const sent = [], beacons = [];
  const telemetry = new BrowserTelemetry({ post: async body => { if (fail) throw new Error("offline"); sent.push(body); },
    beacon: body => { beacons.push(body); return true; } });
  const call = telemetry.begin("conversation-1");
  telemetry.bind(call, "live-1");
  for (let i = 0; i < 150; i++) telemetry.record(call, "connection.state");
  await telemetry.flush();
  assert.equal(telemetry.queue.length, 100);
  telemetry.checkpoint(call, true);
  assert.ok(beacons[0].events.length <= 20);
  assert.equal(beacons[0].events.at(-1).type, "connection.page.exit");
  assert.equal(beacons[0].events.at(-1).detail.reason, "page_exit");
  assert.ok(telemetry.queue.length > 0);
  fail = false;
  await telemetry.flush();
  assert.equal(telemetry.queue.length, 0);
  assert.ok(sent.every(body => body.events.length <= 20));
});

test("unavailable stats remain unknown and an old sample cannot adopt a new session", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  const sent = [];
  const telemetry = new BrowserTelemetry({ post: async body => sent.push(body), beacon: () => false });
  const old = telemetry.begin("conversation-1");
  telemetry.bind(old, "old");
  old.peer = { getStats: async () => { throw new Error("closed"); } };
  await telemetry.end(old, "peer_failed", false);
  const next = telemetry.begin("conversation-1");
  telemetry.bind(next, "new");
  await telemetry.flush();
  const ended = sent.flatMap(body => body.events).find(x => x.type === "call.ended");
  assert.equal(ended.session, "old");
  assert.equal(ended.detail.audioReceived, null);
  assert.equal(ended.detail.statsStatus, "error");
});

test("missing inbound counters are unknown, not evidence of zero audio", async () => {
  const { BrowserTelemetry, summarizeAudio } = await import("../../web/telemetry.js");
  const report = new Map([["a", { type: "inbound-rtp", kind: "audio" }]]);
  assert.equal(summarizeAudio(report).packetsReceived, null);
  assert.equal(summarizeAudio(report).bytesReceived, null);
  const telemetry = new BrowserTelemetry({ post: async () => {}, beacon: () => false });
  const call = telemetry.begin("c");
  call.peer = { getStats: async () => report };
  await telemetry.sample(call);
  assert.equal(call.stats.audioReceived, null);
});

test("navigation during final stats still beacons synchronous close evidence", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  const beacons = [];
  const telemetry = new BrowserTelemetry({ post: async () => {}, beacon: body => beacons.push(body) });
  const call = telemetry.begin("c");
  telemetry.bind(call, "old");
  await telemetry.flush();
  let resolveStats;
  call.peer = { getStats: () => new Promise(resolve => { resolveStats = resolve; }) };
  const pending = telemetry.end(call, "session_replaced", false);
  telemetry.checkpoint(null, true);
  try {
    const closing = beacons.flatMap(b => b.events).find(e => e.detail.reason === "session_replaced");
    assert.ok(closing, "terminal reason must exist before awaiting stats");
    assert.equal(closing.session, "old");
    assert.equal(closing.detail.audioReceived, null);
  } finally {
    resolveStats(new Map());
    await pending;
  }
});

test("generic task errors do not diagnose the voice connection; delayed transport errors keep their call", async () => {
  const { BrowserTelemetry } = await import("../../web/telemetry.js");
  const sent = [];
  const telemetry = new BrowserTelemetry({ post: async body => sent.push(body), beacon: () => false });
  const old = telemetry.begin("c");
  telemetry.bind(old, "old");
  const next = telemetry.begin("c");
  telemetry.bind(next, "new");
  const source = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  // Exercise the actual UI error boundary, with only its DOM/status dependency replaced.
  const context = { telemetry, activeCall: next, window: { __voiceLabEvents: [] }, status() {} };
  runInNewContext(source.slice(source.indexOf("function record("), source.indexOf("function status(")) +
    source.slice(source.indexOf("function showError("), source.indexOf("function openEvents(")), context);
  context.showError(new Error("Task permission failed"));
  await telemetry.flush();
  assert.equal(sent.flatMap(b => b.events).filter(e => e.type === "connection.error").length, 0);
  await Promise.reject(new Error("old transport")).catch(err => context.connectionError(err, old));
  await telemetry.flush();
  const error = sent.flatMap(b => b.events).find(e => e.type === "connection.error");
  assert.equal(error.session, "old");
  assert.equal(error.callId, old.id);
  assert.equal(error.detail.message, undefined);
});
