// Voice smoke test for the gpt-realtime-2.1 deployment on Azure AI Foundry.
// Sends a text prompt over the Realtime WebSocket API and saves the spoken
// response as a playable WAV file (24kHz, 16-bit, mono).
//
// Auth: uses AZURE_TOKEN if provided (pre-fetched Entra token for
// https://ai.azure.com), otherwise falls back to DefaultAzureCredential.

import { writeFileSync } from "node:fs";
import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import { getLogger } from "./src/core/logger.js";

const OVERALL_TIMEOUT_MS = 90_000;
const OUTPUT_WAV = "output.wav";

const logger = await getLogger("voice-test");

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function getToken() {
  if (process.env.AZURE_TOKEN) {
    return process.env.AZURE_TOKEN;
  }
  const credential = new DefaultAzureCredential();
  const provider = getBearerTokenProvider(
    credential,
    "https://ai.azure.com/.default"
  );
  return provider();
}

async function main() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

  if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT is not set.");
  if (!deploymentName)
    throw new Error("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");

  const baseUrl = endpoint.replace(/\/$/, "") + "/openai/v1";
  const token = await getToken();

  const openAIClient = new OpenAI({ baseURL: baseUrl, apiKey: token });
  const realtimeClient = await OpenAIRealtimeWS.create(openAIClient, {
    model: deploymentName,
  });

  const audioChunks = [];
  let transcript = "";

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${OVERALL_TIMEOUT_MS}ms`)),
      OVERALL_TIMEOUT_MS
    );

    realtimeClient.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    realtimeClient.on("session.created", (event) => {
      logger.info("Session created", { sessionId: event.session.id });

      realtimeClient.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions:
            "You are a helpful assistant. You respond by voice and text.",
          output_modalities: ["audio"],
          audio: {
            output: {
              voice: "alloy",
              format: { type: "audio/pcm", rate: 24000 },
            },
          },
        },
      });
    });

    realtimeClient.on("session.updated", (event) => {
      logger.info("Session configured", { sessionId: event.session.id });

      realtimeClient.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "In two upbeat sentences, confirm that the GPT Realtime 2.1 voice deployment on Azure AI Foundry is live and working.",
            },
          ],
        },
      });
      realtimeClient.send({ type: "response.create" });
    });

    realtimeClient.on("response.output_audio.delta", (event) => {
      audioChunks.push(Buffer.from(event.delta, "base64"));
    });

    realtimeClient.on("response.output_audio_transcript.delta", (event) => {
      transcript += event.delta;
    });

    realtimeClient.on("response.done", (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });

  const responseEvent = await done;
  realtimeClient.close();

  const pcm = Buffer.concat(audioChunks);
  writeFileSync(OUTPUT_WAV, pcmToWav(pcm));

  logger.info("Voice test completed", {
    responseId: responseEvent.response.id,
    transcript,
    audioBytes: pcm.length,
    audioSeconds: Number((pcm.length / 2 / 24000).toFixed(2)),
    outputFile: OUTPUT_WAV,
    usage: responseEvent.response.usage,
  });
}

main().catch((err) => {
  logger.error("Voice test failed", { error: err.message, stack: err.stack });
  process.exitCode = 1;
});
