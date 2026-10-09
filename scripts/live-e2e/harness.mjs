// Drive the real voice page in headless Chrome with fake media flags. Chrome's
// fake capture plays a silent WAV; an init script mixes spoken WAVs into that
// same microphone track on demand so each utterance happens at a chosen moment.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { silence } from "./tts.mjs";

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

export async function launch() {
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
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(mixer);
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
    this.session = (await response.json()).session.id;
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
