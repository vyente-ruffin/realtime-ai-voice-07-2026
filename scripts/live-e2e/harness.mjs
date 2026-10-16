// Drive the real voice page in headless Chrome with fake media flags. Chrome's
// fake capture plays a silent WAV; an init script mixes spoken WAVs into that
// same microphone track on demand so each utterance happens at a chosen moment.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { silence } from "./tts.mjs";
import { cleanup } from "./cleanup.mjs";

export const base = process.env.VOICE_E2E_URL || "http://127.0.0.1:8787";
export const statePath = process.env.VOICE_STATE_PATH || resolve(process.env.HOME, ".local/state/jarvis-voice/state.sqlite");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read-only view of the evidence database. */
export function db() {
  return new DatabaseSync(statePath, { readOnly: true });
}
export function query(sql, ...args) {
  const d = db();
  try {
    return d.prepare(sql).all(...args);
  } finally {
    d.close();
  }
}

export async function until(fn, { timeout = 60000, every = 500, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

const mixer = () => {
  // Keep every peer connection the page makes so a test can drop the call like a network loss.
  window.__pcs = [];
  // Wire log: type and ids of every data-channel event each way (never content), so a run can
  // prove each append the page sent and each ack it received has its own audit row.
  window.__wire = [];
  const Peer = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Peer {
    constructor(...args) {
      super(...args);
      window.__pcs.push(this);
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      const send = channel.send.bind(channel);
      channel.send = (text) => {
        try {
          const e = JSON.parse(text);
          window.__wire.push({ dir: "out", at: Date.now(), type: e.type, event_id: e.event_id || null, delegation_id: e.delegation_id || null });
        } catch {}
        return send(text);
      };
      channel.addEventListener("message", (m) => {
        try {
          const e = JSON.parse(m.data);
          if (/appended$|^error$|delegation/.test(e.type))
            window.__wire.push({ dir: "in", at: Date.now(), type: e.type, client_event_id: e.client_event_id || e.error?.event_id || null, delegation_id: e.delegation?.id || null });
        } catch {}
      });
      return channel;
    }
  };
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const fake = await original(constraints);
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const out = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(fake).connect(out);
    window.__mix = { ctx, out, playing: null };
    return out.stream;
  };
  window.__say = async (b64, loop = false) => {
    const { ctx, out } = window.__mix;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buffer = await ctx.decodeAudioData(bytes.buffer);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = loop;
    node.connect(out);
    window.__mix.playing = node;
    const ended = new Promise((r) => (node.onended = r));
    node.start();
    if (!loop) await ended;
    return buffer.duration;
  };
  window.__hush = () => {
    try {
      window.__mix?.playing?.stop();
    } catch {}
  };
};

const ownerConversation = () => JSON.parse(query("SELECT value FROM cache WHERE key='default-conversation'")[0]?.value || "null");
const ownerFragments = () => query("SELECT COUNT(*) AS n FROM fragments WHERE conversation=?", ownerConversation())[0].n;

/** One live test run: its own test conversation on the server, and a cleanup that always runs.
 * Calls never land in the owner's conversation; memories the run creates are invalidated. */
export class TestRun {
  constructor(name) {
    this.name = `${name}-${Date.now().toString(36)}`;
    this.since = Date.now();
    this.words = [];
    this.ownerBefore = ownerFragments();
    this.conversation = null;
  }
  /** A fresh test conversation, created with the key only the local state file holds. */
  async conversationId() {
    if (this.conversation) return this.conversation;
    const key = JSON.parse(query("SELECT value FROM cache WHERE key='test-key'")[0].value);
    const token = (await (await fetch(`${base}/auth-refresh`)).json()).token;
    const r = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Voice-Auth": token },
      // memory: the app saves this test call's speech like a real call (Fix 6); cleanup invalidates it.
      body: JSON.stringify({ test: { key, run: this.name, ...(this.memory ? { memory: true } : {}) } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Test conversation not created: HTTP ${r.status}`);
    this.conversation = (await r.json()).id;
    return this.conversation;
  }
  /** Invalidate everything the run created and prove the owner's conversation is untouched. */
  async finish() {
    const report = await cleanup({ run: this.name, since: this.since, words: this.words, extraSessions: this.extraSessions || [] });
    report.ownerConversationNewFragments = ownerFragments() - this.ownerBefore;
    console.log(`[isolation] owner conversation new fragments: ${report.ownerConversationNewFragments}`);
    return report;
  }
}

/** Run `body(run)` as one isolated test run; cleanup runs even when the body fails. */
export async function testRun(name, body) {
  const run = new TestRun(name);
  let result, error;
  try {
    result = await body(run);
  } catch (err) {
    error = err;
  }
  const report = await run.finish();
  if (error) throw error;
  return { result, cleanup: report };
}

export async function launch(run) {
  if (!run) throw new Error("Live calls need a TestRun so they stay out of the owner's conversation.");
  const conversation = await run.conversationId();
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${silence(5)}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  // The owner's browser zone, so clock answers match a real call.
  const context = await browser.newContext({ permissions: ["microphone"], timezoneId: process.env.VOICE_E2E_TZ || "America/Los_Angeles" });
  await context.addInitScript(mixer);
  // The page keeps its conversation in localStorage; start it in the test conversation.
  await context.addInitScript((id) => localStorage.setItem("jarvis.conversation", JSON.stringify(id)), conversation);
  return { browser, context };
}

export class Call {
  constructor(page) {
    this.page = page;
    this.session = null;
  }
  static async open(context) {
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[page error]", e.message));
    await page.goto(base);
    return new Call(page);
  }
  async start() {
    const live = this.page.waitForResponse((r) => r.url().endsWith("/api/live") && r.request().method() === "POST", { timeout: 60000 });
    await this.page.click("#startBtn");
    const response = await live;
    const body = await response.json();
    if (!response.ok() || !body.session?.id) throw Object.assign(new Error(`Call did not start: HTTP ${response.status()} ${body.title || ""}`.trim()), { connect: true });
    this.session = body.session.id;
    await this.page.waitForFunction(() => window.__voiceLabEvents.some((e) => e.type === "session.started"), null, { timeout: 30000 });
    return this.session;
  }
  /** Speak a WAV into the microphone; resolves when playback ends (or at once when looping). */
  async say(file, { loop = false } = {}) {
    const b64 = readFileSync(file).toString("base64");
    const startedAt = Date.now();
    const duration = await this.page.evaluate(([data, l]) => window.__say(data, l), [b64, loop]);
    return { startedAt, endedAt: Date.now(), duration };
  }
  async hush() {
    await this.page.evaluate(() => window.__hush());
  }
  async type(text) {
    await this.page.fill("#typeBox", text);
    const created = this.page.waitForResponse((r) => r.url().endsWith("/api/delegations"), { timeout: 30000 });
    await this.page.click("#sendBtn");
    return (await (await created).json()).job;
  }
  /** Drop the connection without ending the call: close the page's live RTCPeerConnection,
   * so the app's own reconnect path runs. Resolves with the reconnected session id. */
  async drop({ timeout = 60000 } = {}) {
    const before = this.session;
    const live = this.page.waitForResponse((r) => r.url().endsWith("/api/live") && r.request().method() === "POST", { timeout });
    const started = (await this.events("session.started")).length;
    const droppedAt = Date.now();
    await this.page.evaluate(() => window.__pcs.filter((p) => p.connectionState !== "closed").forEach((p) => p.close()));
    const body = await (await live).json();
    if (!body.session?.id) throw Object.assign(new Error("Reconnect did not start a session"), { connect: true });
    this.session = body.session.id;
    await this.page.waitForFunction((n) => window.__voiceLabEvents.filter((e) => e.type === "session.started").length > n, started, { timeout });
    return { previous: before, session: this.session, droppedAt, reconnectedAt: Date.now() };
  }
  async wire() {
    return this.page.evaluate(() => window.__wire);
  }
  /** The telemetry call id of a session, from the server's session.started audit row. */
  callId(session = this.session) {
    return query("SELECT json_extract(payload,'$.callId') AS id FROM audit WHERE kind='session.started' AND json_extract(payload,'$.session')=?", session)[0]?.id;
  }
  async events(type) {
    return this.page.evaluate((t) => window.__voiceLabEvents.filter((e) => !t || e.type === t), type);
  }
  async end() {
    await this.page.click("#stopBtn");
    await this.page.waitForFunction(() => !document.querySelector("#startBtn").disabled, null, { timeout: 30000 });
    await sleep(1500); // let the transcript outbox flush
  }
}

/** Lines per speaker for one session, with server receipt times. GPT-Live user and
 * assistant fragments interleave, so each speaker's fragments are joined in order
 * (Microsoft Learn, "Use GPT-Live for real-time voice", "Read transcripts"). */
export function turns(session) {
  const rows = query("SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid", session);
  const out = [];
  const open = {};
  for (const r of rows) {
    const last = open[r.role];
    if (last && r.start_ms - last.end_ms < 1800) {
      last.text += r.text;
      last.end_ms = r.end_ms;
      last.lastAt = r.at;
    } else out.push((open[r.role] = { role: r.role, text: r.text, at: r.at, lastAt: r.at, start_ms: r.start_ms, end_ms: r.end_ms }));
  }
  return out;
}
