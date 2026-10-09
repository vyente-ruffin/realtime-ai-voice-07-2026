// Spoken test utterances from Azure Speech with the existing keyless az login
// (Entra bearer token on the AIServices custom domain; no keys anywhere).
// Audio is cached under logs/ (git-ignored): never commit audio artifacts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
