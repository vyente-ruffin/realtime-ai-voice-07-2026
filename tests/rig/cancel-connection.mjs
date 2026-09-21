import { chromium } from "playwright";
import assert from "node:assert/strict";
import { installAudioProbe } from "./audio-probe.js";
import { getLogger } from "../../src/core/logger.js";
const logger = await getLogger("cancel-connection-rig");
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"], {
    origin: "http://127.0.0.1:8789",
  });
  await context.addInitScript(installAudioProbe);
  const page = await context.newPage();
  let requested;
  const pending = new Promise((r) => (requested = r));
  await page.route("**/api/live", async (route) => {
    requested();
    await new Promise((r) => setTimeout(r, 1200));
    await route.abort();
  });
  await page.goto("http://127.0.0.1:8789/?synthetic=1");
  await page.click("#startBtn");
  await pending;
  await page.click("#stopBtn");
  await page.waitForTimeout(2300);
  assert.equal(await page.locator("#startBtn").isEnabled(), true);
  assert.match(await page.locator("#status").textContent(), /ended/);
  assert.equal(
    await page.evaluate(() =>
      window.__audioProbe.peers.every((p) => p.connectionState === "closed"),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      window.__voiceLabEvents.some((e) => e.type === "session.started"),
    ),
    false,
  );
  logger.info(
    "Stopping during connection releases audio and ignores the late response",
  );
} finally {
  await browser.close();
}
