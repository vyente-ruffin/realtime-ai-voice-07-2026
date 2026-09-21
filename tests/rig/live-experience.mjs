// Failure and continuity checks against a real isolated GPT-Live + Hermes instance.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { installAudioProbe } from "./audio-probe.js";
import { getLogger } from "../../src/core/logger.js";
const logger = await getLogger("voice-experience-rig");
const arg = (k, v) => {
  const i = process.argv.indexOf("--" + k);
  return i < 0 ? v : process.argv[i + 1];
};
const base = arg("url", "http://127.0.0.1:8789"),
  out = arg("out", "/tmp/live-experience");
mkdirSync(out, { recursive: true, mode: 0o700 });
const report = {
  started: new Date().toISOString(),
  reconnects: [],
  jobs: [],
  interruptions: [],
  failures: [],
};
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext();
await context.grantPermissions(["microphone"], { origin: base });
await context.addInitScript(installAudioProbe);
const page = await context.newPage();
page.on("pageerror", (e) =>
  report.failures.push({ kind: "browser", message: e.message }),
);
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
async function api(path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/auth-refresh");
      const { token } = await r.json();
      const x = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-Voice-Auth": token },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: x.status, data: await x.json() };
    },
    { path, body },
  );
}
async function fixture(path, id) {
  return page.evaluate(({ wav, id }) => window.__audioProbe.play(wav, id), {
    wav: readFileSync(path).toString("base64"),
    id,
  });
}
try {
  await page.goto(base + "/?synthetic=1");
  await page.click("#startBtn");
  await page.waitForFunction(
    () => window.__voiceLabEvents.some((e) => e.type === "session.started"),
    null,
    { timeout: 30000 },
  );
  const conversation = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("jarvis.conversation")),
  );
  await page.waitForTimeout(1500);
  const taskCount = Number(arg("jobs", "20"));
  const reconnectCount = Number(arg("reconnects", "10"));
  for (let i = 1; i <= taskCount; i++) {
    const text = `Qualification task ${i}: calculate ${i} times 101. Return only the task number and the numeric result.`;
    const session = await page.evaluate(
      () =>
        window.__voiceLabEvents
          .filter((e) => e.type === "session.started")
          .at(-1).session.id,
    );
    const response = await api("/api/delegations", {
      conversation,
      session,
      delegation: `typed_qualification_${i}`,
      events: [
        {
          type: "session.input_transcript.delta",
          event_id: `qualification_${i}`,
          delta: text,
          start_ms: i * 1000,
          end_ms: i * 1000 + 500,
        },
      ],
    });
    if (response.status !== 202)
      throw new Error(`Task ${i} rejected: ${response.status}`);
    report.jobs.push({
      id: response.data.job.id,
      number: i,
      expected: i * 101,
    });
    // Re-send the same request once to test a lost acknowledgment against the real worker.
    const duplicate = await api("/api/delegations", {
      conversation,
      session,
      delegation: `typed_qualification_${i}`,
      events: [],
    });
    if (duplicate.data.job?.id !== response.data.job.id)
      report.failures.push({ kind: "duplicate", number: i });
    if (i <= reconnectCount) {
      const before = await page.evaluate(
        () =>
          window.__voiceLabEvents.filter((e) => e.type === "session.started")
            .length,
      );
      await context.setOffline(true);
      await page.evaluate(() =>
        window.__audioProbe.peers.forEach((p) => p.close()),
      );
      await page.waitForTimeout(2200);
      const start = Date.now();
      await context.setOffline(false);
      try {
        await page.waitForFunction(
          (n) =>
            window.__voiceLabEvents.filter((e) => e.type === "session.started")
              .length > n,
          before,
          { timeout: 20000 },
        );
        report.reconnects.push({
          attempt: i,
          ms: Date.now() - start,
          failed: false,
        });
      } catch (err) {
        report.reconnects.push({
          attempt: i,
          ms: Date.now() - start,
          failed: true,
        });
        throw err;
      }
      logger.info("connection recovered", report.reconnects.at(-1));
    }
    persist();
    await page.waitForTimeout(i <= reconnectCount ? 7000 : 500);
  }
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const r = await api(`/api/jobs?conversation=${conversation}`);
    const jobs = r.data.jobs;
    for (const row of report.jobs) {
      const state = jobs.find((j) => j.id === row.id);
      Object.assign(row, {
        state: state?.state,
        result: state?.result,
        error: state?.error,
        delivery: state?.delivery,
      });
    }
    persist();
    if (
      report.jobs.every((j) =>
        ["completed", "failed", "interrupted", "cancelled"].includes(j.state),
      )
    )
      break;
    await page.waitForTimeout(2000);
  }
  // Leave enough room for separate result announcements; collect the actual speech below.
  await page.waitForTimeout(10000);
  try {
    await page.waitForFunction(
      (n) =>
        window.__voiceLabEvents.filter(
          (e) => e.type === "result.context.accepted",
        ).length >= n &&
        performance.now() - window.__audioProbe.lastSound > 3000,
      taskCount,
      { timeout: 120000 },
    );
  } catch {
    report.failures.push({
      kind: "speech_delivery",
      message:
        "Not all results were injected and followed by settled playback before the deadline.",
    });
  }
  if (arg("story", null) && arg("interrupt", null)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const story = await fixture(arg("story"), `story-${attempt}`);
      // A backchannel can begin before the recorded request has finished.
      // Wait for the complete input and sustained reply before interrupting.
      await page.waitForFunction(
        ({ end }) => {
          const p = window.__audioProbe;
          const now = performance.now();
          return now > end + 1300 && p.lastSound > now - 150 &&
            p.events.filter(e => e.type === "playback.sample" && e.at > now - 500).length >= 15;
        },
        story,
        { timeout: 20000 },
      );
      const input = await fixture(arg("interrupt"), `interrupt-${attempt}`);
      await page.waitForTimeout(7000);
      const measured = await page.evaluate((input) => {
        const samples = window.__audioProbe.events.filter(
          (e) =>
            e.type === "playback.sample" &&
            e.at >= input.start - 100 &&
            e.at <= input.end + 500,
        );
        const before = samples.filter(e => e.at < input.start).at(-1);
        if (!before || input.start - before.at > 100)
          return { yieldMs: null, valid: false, reason: "Assistant was not speaking when interrupted", input, samples: samples.length };
        let last = input.start;
        for (const sample of samples.filter(e => e.at >= input.start)) {
          if (sample.at - last > 250)
            return {
              yieldMs: Math.max(0, last - input.start),
              valid: true,
              input,
              samples: samples.length,
            };
          last = sample.at;
        }
        if (input.end + 500 - last > 250)
          return { yieldMs: Math.max(0, last - input.start), valid: true, input, samples: samples.length };
        return { yieldMs: null, valid: true, input, samples: samples.length };
      }, input);
      measured.passed = measured.valid && measured.yieldMs !== null && measured.yieldMs <= 500;
      report.interruptions.push(measured);
      if (!measured.passed) {
        report.failures.push({ kind: "interruption", attempt: attempt + 1, ...measured });
        process.exitCode = 1;
      }
      logger.info("interruption checked", { attempt: attempt + 1, ...measured });
      persist();
      await page.waitForFunction(() => performance.now() - window.__audioProbe.lastSound > 2000, null, {timeout: 20000});
    }
  }
} catch (err) {
  report.failures.push({ kind: "run", message: err.message });
  process.exitCode = 1;
} finally {
  try {
    if (await page.locator("#stopBtn").isEnabled()) {
      await page.click("#stopBtn");
      await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, {timeout: 17000});
    }
  } catch (err) { report.failures.push({kind: "close", message: err.message}); }
  try {
    const recording = await page.evaluate(() => window.__audioProbe.export());
    const pcm = Buffer.from(recording.pcm, "base64");
    const h = Buffer.alloc(44);
    h.write("RIFF");
    h.writeUInt32LE(pcm.length + 36, 4);
    h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(recording.rate, 24);
    h.writeUInt32LE(recording.rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    writeFileSync(join(out, "received-audio.wav"), Buffer.concat([h, pcm]), {
      mode: 0o600,
    });
    delete recording.pcm;
    writeFileSync(
      join(out, "events.json"),
      JSON.stringify(recording, null, 2),
      { mode: 0o600 },
    );
  } catch (err) {
    report.failures.push({ kind: "capture", message: err.message });
  }
  persist();
  await browser.close();
  logger.info("experience run recorded", {
    out,
    failures: report.failures.length,
  });
}
