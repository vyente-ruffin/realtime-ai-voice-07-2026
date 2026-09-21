// Real browser/audio path. Synthetic microphone; received PCM is recorded separately
// from model transcript events. This is a browser playback proxy, not a phone test.
import { chromium } from "playwright";
import { installAudioProbe } from "./audio-probe.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { getLogger } from "../../src/core/logger.js";
const log = await getLogger("audio-baseline");
const opt = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const base = opt("url", "http://127.0.0.1:8788");
const output = resolve(opt("out", "/tmp/voice-baseline"));
const cases = JSON.parse(readFileSync(opt("cases"), "utf8"));
const timeout = Number(opt("timeout", "70")) * 1000;
mkdirSync(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
let page;
const report = {
  started: new Date().toISOString(),
  base,
  measurement:
    "Synthetic microphone to received browser PCM; meaningful speech requires recording review.",
  cases: [],
};
try {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["microphone"], { origin: new URL(base).origin });
  page = await ctx.newPage();
  // Ending this legacy session must not instruct Hermes to contact Telegram.
  await page.route("**/session-end", (route) => route.fulfill({ status: 204 }));
  await page.addInitScript(installAudioProbe);
  await page.goto(base + "/?synthetic=1");
  report.server = await page.evaluate(async () =>
    (await fetch("/healthz")).json(),
  );
  report.connectStarted = Date.now();
  await page.click("#startBtn");
  await page.waitForFunction(
    () =>
      window.__voiceLabEvents?.some((e) =>
        ["session.created", "session.started"].includes(e.type),
      ) || document.getElementById("status").textContent.startsWith("❌"),
    null,
    { timeout: 40000 },
  );
  const status = await page.locator("#status").textContent();
  if (status.startsWith("❌")) throw new Error(status);
  report.connectionMs = Date.now() - report.connectStarted;
  await page.waitForTimeout(1500);
  for (const c of cases) {
    const wav = readFileSync(resolve(c.wav));
    const start = await page.evaluate(
      ({ wav, id }) => window.__audioProbe.play(wav, id),
      { wav: wav.toString("base64"), id: c.id },
    );
    const row = { ...c, microphone: start, failed: false };
    try {
      await page.waitForFunction(
        ({ end }) => {
          const p = window.__audioProbe;
          return p.lastSound > end && performance.now() - p.lastSound > 2200;
        },
        start,
        { timeout },
      );
    } catch {
      row.failed = true;
      row.error = "No completed audible response inside timeout";
    }
    row.completedAt = await page.evaluate(() => performance.now());
    const first = await page.evaluate(
      (end) =>
        window.__audioProbe.events.find(
          (e) => e.type === "playback.sound.start" && e.at > end,
        ),
      start.end,
    );
    row.firstAudibleMs = first ? first.at - start.end : null;
    row.meaningfulAudibleMs = null; // classify against the recording; filler is not an answer.
    report.cases.push(row);
    log.info("audio case recorded", {
      id: c.id,
      firstAudibleMs: row.firstAudibleMs,
      failed: row.failed,
    });
    writeFileSync(
      join(output, "results.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    await page.waitForTimeout(1500);
  }
  if (Number(opt("tail", "0")) > 0)
    await page.waitForTimeout(Number(opt("tail", "0")) * 1000);
} catch (err) {
  report.failure = err.message;
  process.exitCode = 1;
  log.error("audio run failed", { error: err.message });
} finally {
  if (page) {
    try {
      if (await page.locator("#stopBtn").isEnabled()) {
        await page.click("#stopBtn");
        await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, {timeout: 17000});
      }
    } catch (err) { report.shutdownError = err.message; }
    try {
      const captured = await page.evaluate(() => window.__audioProbe.export());
      const pcm = Buffer.from(captured.pcm, "base64");
      const header = Buffer.alloc(44);
      header.write("RIFF");
      header.writeUInt32LE(pcm.length + 36, 4);
      header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(captured.rate, 24);
      header.writeUInt32LE(captured.rate * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(pcm.length, 40);
      writeFileSync(
        join(output, "received-audio.wav"),
        Buffer.concat([header, pcm]),
        { mode: 0o600 },
      );
      delete captured.pcm;
      writeFileSync(
        join(output, "events.json"),
        JSON.stringify(
          captured,
          (k, v) => (/secret|token|authorization/i.test(k) ? "[redacted]" : v),
          2,
        ),
        { mode: 0o600 },
      );
    } catch (err) {
      report.captureError = err.message;
    }
  }
  writeFileSync(join(output, "results.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  await browser.close();
}
