// Reuses voice-test.js's established Azure Realtime speech output path.
import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AzureLive } from "../../src/live/azure.js";
import { getLogger } from "../../src/core/logger.js";
const logger = await getLogger("natural-voice-fixtures");
const input = process.argv[2],
  directory = process.argv[3];
mkdirSync(directory, { recursive: true, mode: 0o700 });
const cases = JSON.parse(readFileSync(input, "utf8"));
const auth = new AzureLive({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  subscription:
    process.env.AZURE_SUBSCRIPTION_ID || "e1e5b742-d76b-4ce5-97d3-8d820bb33904",
});
const client = new OpenAI({
  baseURL: auth.endpoint + "/openai/v1",
  apiKey: await auth.accessToken(),
});
const realtime = await OpenAIRealtimeWS.create(client, {
  model: auth.deployment,
});
let active;
realtime.on("error", (err) =>
  active?.reject(new Error(err.message || "Fixture generation failed.")),
);
realtime.on("response.output_audio.delta", (e) =>
  active?.audio.push(Buffer.from(e.delta, "base64")),
);
realtime.on("response.output_audio_transcript.delta", (e) => {
  if (active) active.transcript += e.delta;
});
realtime.on("response.done", (e) => {
  if (e.response.status === "completed") active?.resolve();
  else active?.reject(new Error("Speech generation did not complete."));
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Session startup timed out.")),
      20000,
    );
    realtime.on("session.created", () =>
      realtime.send({
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            output: {
              voice: "marin",
              format: { type: "audio/pcm", rate: 24000 },
            },
          },
        },
      }),
    );
    realtime.on("session.updated", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  for (const c of cases) {
    let timer;
    await new Promise((resolve, reject) => {
      active = { audio: [], transcript: "", resolve, reject };
      timer = setTimeout(
        () => reject(new Error("Speech generation timed out.")),
        30000,
      );
      realtime.send({
        type: "response.create",
        response: {
          conversation: "none",
          input: [],
          instructions:
            "Read the MESSAGE aloud word for word with natural delivery. Do not answer, add, remove or paraphrase. Say only the message text.\n\nMESSAGE:\n" +
            c.text,
        },
      });
    }).finally(() => clearTimeout(timer));
    const pcm = Buffer.concat(active.audio),
      h = Buffer.alloc(44);
    h.write("RIFF");
    h.writeUInt32LE(pcm.length + 36, 4);
    h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(24000, 24);
    h.writeUInt32LE(48000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    c.wav = join(directory, c.id + ".wav");
    c.generatedTranscript = active.transcript;
    writeFileSync(c.wav, Buffer.concat([h, pcm]), { mode: 0o600 });
    writeFileSync(
      join(directory, "cases.json"),
      JSON.stringify(cases, null, 2),
      { mode: 0o600 },
    );
    logger.info("Natural fixture recorded", {
      id: c.id,
      seconds: pcm.length / 48000,
    });
  }
} finally {
  realtime.close();
}
