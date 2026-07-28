import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const qs = JSON.parse(readFileSync(process.argv[2] || "/tmp/q30.json", "utf8"));
const limit = Number(process.argv[3] || qs.length);
const b = await chromium.launch({ channel: "chrome", args: [
  "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required" ]});
const c = await b.newContext(); await c.grantPermissions(["microphone"], { origin: "http://localhost:8787" });
const p = await c.newPage();
await p.goto("http://localhost:8787/");
await p.click("#startBtn");
await p.waitForFunction(() => document.getElementById("status").textContent.includes("Connected"), { timeout: 60000 });
const results = [];
for (let i = 0; i < limit; i++) {
  const { q, expect } = qs[i];
  await p.evaluate(() => { if (window.__auditSeen === undefined) window.__auditSeen = 0; });
  await p.fill("#typeBox", q);
  await p.press("#typeBox", "Enter");
  // Fillers finish first; wait for a transcript that is NOT one.
  const FILLER = /One sec|Let me think|Still with you|Hang on|Give me a beat/i;
  const got = await p.waitForFunction(() =>
    window.__voiceLabEvents.filter(e =>
      e.type === "response.output_audio_transcript.done" &&
      !/One sec|Let me think|Still with you|Hang on|Give me a beat/i.test(e.transcript || e.text || "")
    ).length > window.__auditSeen,
    null, { timeout: 240000 }).then(()=>true).catch(()=>false);
  const spoken = await p.evaluate(() => {
    const real = window.__voiceLabEvents.filter(e =>
      e.type === "response.output_audio_transcript.done" &&
      !/One sec|Let me think|Still with you|Hang on|Give me a beat/i.test(e.transcript || e.text || ""));
    window.__auditSeen = real.length;
    return real.length ? (real[real.length-1].transcript || real[real.length-1].text || "") : "";
  });
  // authoritative pair comes from the server's audit log
  let hermesSaid = "";
  try {
    const lines = readFileSync("logs/voice-audit.log","utf8").trim().split("\n").map(JSON.parse);
    const mine = lines.filter(r => r.kind === "reply" && r.question && q.startsWith(r.question.slice(0,25)));
    hermesSaid = mine.length ? mine[mine.length-1].hermesSaid : "";
  } catch {}
  results.push({ n: i+1, q, expect, hermesSaid, spoken, answered: got });
  console.log(`${i+1}/${limit} ${got ? "" : "TIMEOUT "}${q.slice(0,42)} -> ${spoken.slice(0,60)}`);
}
writeFileSync("/tmp/audit-results.json", JSON.stringify(results, null, 2));
await b.close();
