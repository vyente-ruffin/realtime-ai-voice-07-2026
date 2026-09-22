// Real GPT-Live + Hindsight check, restricted to the existing fictional qualification bank.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { installAudioProbe } from "./audio-probe.js";
const [base, output, casesFile, configFile, modelId = "jarvis-voice-profile", correctedCity = "Boise"] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (!/^voice-qualification-[a-z0-9-]+$/.test(config.bank_id || config.bankId || ""))
  throw new Error("This test may only use the fictional qualification bank.");
const root = `${config.api_url.replace(/\/$/, "")}/v1/default/banks/${config.bank_id}`;
const cases = JSON.parse(readFileSync(casesFile, "utf8"));
const cityWav = process.env.VOICE_TEST_CITY_WAV || join(dirname(cases[0]?.wav || casesFile), "memory-03.wav");
async function hindsight(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(root + path, { method,
    headers: { Authorization: `Bearer ${config.api_key || config.apiKey}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Hindsight ${response.status}`);
  return response.json();
}
mkdirSync(output, { recursive: true, mode: 0o700 });
const runId = Date.now();
const report = { cases: [], failures: [], started: new Date().toISOString(), modelId, correctedCity };
const persist = () => writeFileSync(join(output, "results.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const browser = await chromium.launch({ channel: "chrome", args: [
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
] });
const context = await browser.newContext();
await context.grantPermissions(["microphone"], { origin: base });
await context.addInitScript(installAudioProbe);
const page = await context.newPage();
await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({status:200,body:""})); // Font downloads are outside the voice test.

page.on("pageerror", error => report.failures.push(error.message));
async function ask(item) {
  const before = await page.evaluate(() => window.__voiceLabEvents.length);
  const input = await page.evaluate(({ wav, id }) => window.__audioProbe.play(wav, id),
    { wav: readFileSync(item.wav).toString("base64"), id: item.id });
  await page.waitForFunction(({ end }) => {
    const probe = window.__audioProbe;
    return probe.lastSound > end && performance.now() - probe.lastSound > 2400;
  }, input, { timeout: 30000 });
  const result = await page.evaluate(({ end, before }) => {
    const events = window.__voiceLabEvents.slice(before);
    const first = window.__audioProbe.events.find(event => event.type === "playback.sound.start" && event.at > end);
    return {
      spoken: events.filter(event => event.type === "session.output_transcript.delta").map(event => event.delta).join(""),
      delegations: events.filter(event => event.type === "session.delegation.created").length,
      firstAudibleMs: first ? first.at - end : null,
    };
  }, { end: input.end, before });
  const row = { id: item.id, expected: item.expected, ...result };
  row.correct = result.spoken.toLowerCase().includes(item.expected.toLowerCase());
  row.waitingPreface = /\b(checking|hold on|one moment|let me check|i.?ll check)\b/i.test(result.spoken);
  report.cases.push(row);
  if (!row.correct || row.delegations || row.waitingPreface) report.failures.push("Memory answer failed: " + item.id);
  console.log(JSON.stringify(row));
  persist();
  await page.waitForTimeout(1200);
}
let changed = false;
try {
  await page.goto(base + "/?synthetic=1");
  await page.click("#startBtn");
  await page.waitForFunction(() => window.__voiceLabEvents.some(event => event.type === "session.started"), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  for (const item of cases) await ask(item);
  await page.waitForTimeout(1500);
  const initialModel = await hindsight("/mental-models/" + modelId);
  report.refreshSettings = initialModel.trigger;
  const quietStart = await page.evaluate(() => window.__voiceLabEvents.length);
  report.correctionStarted = Date.now();
  await hindsight("/memories", { async: true, operation_id: randomUUID(), items: [{
    document_id: `voice-memory-upgrade-${runId}-city-correction`,
    content: `Correction: my home is now ${correctedCity}, not Portland.`,
    timestamp: new Date().toISOString(),
    context: "An explicit correction from the fictional qualification user in another conversation. It supersedes their earlier Portland home.",
  }] });
  changed = true;
  let revision;
  const deadline = report.correctionStarted + 600000;
  while (Date.now() < deadline) {
    const model = await hindsight("/mental-models/" + modelId);
    if ((model.content || "").includes(correctedCity) && model.last_refreshed_at !== initialModel.last_refreshed_at) {
      revision = createHash("sha256").update(model.content.trim()).digest("hex").slice(0, 16);
      report.summaryUpdatedMs = Date.now() - report.correctionStarted;
      console.log(JSON.stringify({ stage: "summary-updated", elapsedMs: report.summaryUpdatedMs }));
      persist();
      break;
    }
    await page.waitForTimeout(5000);
  }
  if (!revision) throw new Error("Hindsight did not automatically refresh the corrected fact.");
  await page.waitForFunction(({revision, modelId}) => window.__voiceLabEvents.some(event =>
    event.type === "memory.context.accepted" && event.id === modelId && event.revision === revision),
    {revision, modelId}, { timeout: Math.max(1, Math.min(75000, deadline - Date.now())) });
  report.liveContextUpdatedMs = Date.now() - report.correctionStarted;
  report.unsolicitedUpdateSpeech = await page.evaluate(before => window.__voiceLabEvents.slice(before)
    .filter(event => event.type === "session.output_transcript.delta").map(event => event.delta).join(""), quietStart);
  if (report.unsolicitedUpdateSpeech.trim()) report.failures.push("Quiet refresh produced unsolicited speech.");
  await ask({ id: "updated-city", expected: correctedCity,
    wav: cityWav });
  report.sameSession = true;
  report.updatedAnswerMs = Date.now() - report.correctionStarted;
  if (report.updatedAnswerMs > 600000) report.failures.push("Corrected spoken answer exceeded ten minutes.");
  const firstSession = await page.evaluate(() => window.__voiceLabEvents.find(event => event.type === "session.started").session.id);
  await page.click("#stopBtn");
  await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, {timeout:17000});
  await page.click("#startBtn");
  await page.waitForFunction(first => window.__voiceLabEvents.some(event => event.type === "session.started" && event.session.id !== first), firstSession, {timeout:30000});
  await page.waitForTimeout(1500);
  await ask({ id: "reconnected-city", expected: correctedCity,
    wav: cityWav });
  report.reconnectedSession = true;
} catch (error) {
  report.failures.push(error.message);
} finally {
  try {
    const capture = await page.evaluate(() => window.__audioProbe.export());
    writeFileSync(join(output, "capture.json"), JSON.stringify(capture), { mode: 0o600 });
    if (await page.locator("#stopBtn").isEnabled()) await page.click("#stopBtn");
    await page.waitForTimeout(1500);
  } catch {}
  await browser.close();
  if (changed) await hindsight("/memories", { async: true, operation_id: randomUUID(), items: [{
    document_id: `voice-memory-upgrade-${runId}-city-restored`,
    content: `Correction for the fictional test profile: my home is Portland. ${correctedCity} was temporary and is no longer current.`,
    timestamp: new Date().toISOString(), context: "Explicit latest correction by the fictional qualification user.",
  }] }).catch(error => report.failures.push("Fixture restore: " + error.message));
  persist();
}
if (report.failures.length) process.exitCode = 1;
