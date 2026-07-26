// Synthetic voice rig driver — launches Chromium with a fake microphone fed
// from a WAV file, runs a Voice Lab session, and dumps the page's event log
// as JSON for gate scripts to assert on.
//
// Mechanism citations: custom launch args [P1], microphone permission [P2].
// The specific Chromium switches are LIVE-12: proven by this rig's own gates.
//
// Usage:
//   node driver.mjs --wav f.wav --out events.json [--puppet 1|0]
//                   [--watch 12] [--speak-file corpus.json]

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLogger } from "../../src/core/logger.js";

const logger = await getLogger("voice-rig");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const wav = arg("wav", null);
const out = arg("out", "/tmp/rig-events.json");
const puppet = arg("puppet", "1") === "1";
const watchSecs = Number(arg("watch", "12"));
const speakFile = arg("speak-file", null);
const noRoute = arg("noroute", "0") === "1";
const rotateSecs = arg("rotate-secs", "0");

if (!wav) {
  logger.error("--wav is required");
  process.exit(2);
}

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${resolve(wav)}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

try {
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"], { origin: "http://localhost:8787" });
  const page = await context.newPage();

  await page.goto(
    `http://localhost:8787/?test=1&puppet=${puppet ? 1 : 0}${noRoute ? "&noroute=1" : ""}` +
    (rotateSecs !== "0" ? `&rotate_secs=${rotateSecs}` : "")
  );
  await page.click("#startBtn");

  // Wait for connection (status set by session.created handler) or failure.
  await page.waitForFunction(
    () => {
      const s = document.getElementById("status").textContent;
      const ready = window.__voiceLabEvents.some((e) => e.type === "session.created");
      return ready || s.startsWith("❌");
    },
    { timeout: 30_000 }
  );
  const status = await page.evaluate(() => document.getElementById("status").textContent);
  if (status.startsWith("❌")) {
    logger.error("session failed to connect", { status });
    process.exit(3);
  }
  logger.info("session connected", { puppet, wav });

  // API auth token is injected into the served page (security hardening
  // 2026-07-26); the rig reads it from the DOM like any legitimate client.
  const voiceAuth = await page.evaluate(
    () => document.querySelector('meta[name="voice-auth"]').content
  );

  // Optional scripted injections: wait for each response.done before the next.
  if (speakFile) {
    const corpus = JSON.parse(readFileSync(speakFile, "utf8"));
    for (const text of corpus) {
      const before = await page.evaluate(
        () => window.__voiceLabEvents.filter((e) => e.type === "response.done").length
      );
      const resp = await fetch("http://localhost:8787/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Voice-Auth": voiceAuth },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        logger.error("/speak failed", { status: resp.status });
        process.exit(4);
      }
      await page.waitForFunction(
        (n) => window.__voiceLabEvents.filter((e) => e.type === "response.done").length > n,
        before,
        { timeout: 45_000 }
      );
      logger.info("injection spoken", { text: text.slice(0, 40) });
    }
  }

  // Watch window for the WAV-driven interaction to play out.
  await page.waitForTimeout(watchSecs * 1000);

  const events = await page.evaluate(() => window.__voiceLabEvents);
  writeFileSync(out, JSON.stringify({ puppet, wav, events }, null, 2));
  logger.info("events dumped", { out, count: events.length });
  process.exit(0);
} catch (err) {
  // Preserve diagnostics: a timeout with no event dump hides the cause.
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages.length) {
      const events = await pages[0].evaluate(() => window.__voiceLabEvents ?? []);
      writeFileSync(out, JSON.stringify({ failed: true, error: err.message, events }, null, 2));
      logger.error("rig failed — events preserved", { error: err.message, out, count: events.length });
    } else {
      logger.error("rig failed", { error: err.message });
    }
  } catch {
    logger.error("rig failed", { error: err.message });
  }
  process.exit(1);
} finally {
  await browser.close();
}
