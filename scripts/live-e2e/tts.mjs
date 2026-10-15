// Spoken test utterances from Azure Speech with the existing keyless az login
// (Entra bearer token on the AIServices custom domain; no keys anywhere).
// Audio is cached under logs/ (git-ignored): never commit audio artifacts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
export const audioDir = join(root, "logs/live-e2e/audio");
const subscription = process.env.AZURE_SUBSCRIPTION_ID || "e1e5b742-d76b-4ce5-97d3-8d820bb33904";
const endpoint = process.env.AZURE_SPEECH_ENDPOINT || "https://ai103-resource-ruffin.cognitiveservices.azure.com";
let token = null;

function bearer() {
  if (token && token.until > Date.now()) return token.value;
  const value = execFileSync("az", ["account", "get-access-token", "--subscription", subscription,
    "--resource", "https://cognitiveservices.azure.com", "--query", "accessToken", "-o", "tsv"],
    { encoding: "utf8", timeout: 60000 }).trim();
  token = { value, until: Date.now() + 30 * 60000 };
  return value;
}

const escape = (s) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** 48 kHz mono 16-bit PCM WAV. `continuous` trims sentence/comma pauses so VAD hears one long turn. */
export async function speech(text, { continuous = false, voice = "en-US-AndrewNeural" } = {}) {
  mkdirSync(audioDir, { recursive: true, mode: 0o700 });
  const file = join(audioDir, createHash("sha256").update(`${voice}:${continuous}:${text}`).digest("hex").slice(0, 16) + ".wav");
  if (existsSync(file)) return file;
  const tight = continuous
    ? `<mstts:silence type="Sentenceboundary-exact" value="80ms"/><mstts:silence type="Comma-exact" value="60ms"/>`
    : "";
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${voice}">${tight}${escape(text)}</voice></speak>`;
  const response = await fetch(`${endpoint}/tts/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer()}`,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "riff-48khz-16bit-mono-pcm",
      "User-Agent": "jarvis-voice-e2e",
    },
    body: ssml,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Speech synthesis failed: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  return file;
}

/** Silent WAV used as Chrome's fake capture file; the harness mixes utterances in on demand. */
export function silence(seconds = 5) {
  mkdirSync(audioDir, { recursive: true, mode: 0o700 });
  const file = join(audioDir, `silence-${seconds}s.wav`);
  if (existsSync(file)) return file;
  const rate = 48000, bytes = rate * 2 * seconds;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  writeFileSync(file, Buffer.concat([h, Buffer.alloc(bytes)]), { mode: 0o600 });
  return file;
}

/** 16-bit mono PCM samples of a WAV written by `speech()` or `silence()` (48 kHz). */
function pcm(file) {
  const buf = readFileSync(file);
  for (let i = 12; i + 8 <= buf.length; ) {
    const id = buf.toString("ascii", i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === "data") return buf.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size & 1);
  }
  throw new Error(`No PCM data in ${file}`);
}
/** Cut leading and trailing near-silence so a gap between parts is exactly the silence asked for. */
function trim(samples, threshold = 300) {
  const n = samples.length / 2;
  let a = 0, b = n - 1;
  while (a < n && Math.abs(samples.readInt16LE(a * 2)) < threshold) a++;
  while (b > a && Math.abs(samples.readInt16LE(b * 2)) < threshold) b--;
  return samples.subarray(a * 2, (b + 1) * 2);
}
/** One 48 kHz mono WAV from spoken parts and exact silences, e.g. [file, { silence: 1.5 }, file].
 * Returns the file and each part's [start, end] offset in seconds. */
export function splice(parts, name) {
  mkdirSync(audioDir, { recursive: true, mode: 0o700 });
  const rate = 48000;
  const chunks = [], offsets = [];
  let at = 0;
  for (const p of parts) {
    const data = typeof p === "string" ? trim(pcm(p)) : Buffer.alloc(Math.round(p.silence * rate) * 2);
    chunks.push(data);
    offsets.push([at / rate, (at + data.length / 2) / rate]);
    at += data.length / 2;
  }
  const bytes = at * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  const file = join(audioDir, `${name}.wav`);
  writeFileSync(file, Buffer.concat([h, ...chunks]), { mode: 0o600 });
  return { file, offsets };
}
