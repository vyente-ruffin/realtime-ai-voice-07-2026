import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import { OpenAIRealtimeError } from "openai/realtime/internal-base";

let isCreated = false;
let isConfigured = false;
let responseDone = false;

const throwOnError = true;

async function main() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

  if (!endpoint) {
    throw new Error("AZURE_OPENAI_ENDPOINT is not set.");
  }

  if (!deploymentName) {
    throw new Error("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");
  }

  const baseUrl = endpoint.replace(/\/$/, "") + "/openai/v1";

  const credential = new DefaultAzureCredential();
  const scope = "https://ai.azure.com/.default";
  const azureADTokenProvider = getBearerTokenProvider(credential, scope);
  const token = await azureADTokenProvider();

  const openAIClient = new OpenAI({
    baseURL: baseUrl,
    apiKey: token,
  });

  const realtimeClient = await OpenAIRealtimeWS.create(openAIClient, {
    model: deploymentName,
  });

  realtimeClient.on("error", receiveError);
  realtimeClient.on("session.created", receiveEvent);
  realtimeClient.on("session.updated", receiveEvent);
  realtimeClient.on("response.output_audio.delta", receiveEvent);
  realtimeClient.on("response.output_audio_transcript.delta", receiveEvent);
  realtimeClient.on("response.done", receiveEvent);

  console.log("Waiting for events...");

  while (!isCreated) {
    console.log("Waiting for session.created event...");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const sessionConfig = {
    type: "realtime",
    instructions: "You are a helpful assistant. You respond by voice and text.",
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: {
          model: "whisper-1",
        },
        format: {
          type: "audio/pcm",
          rate: 24000,
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
          create_response: true,
        },
      },
      output: {
        voice: "alloy",
        format: {
          type: "audio/pcm",
          rate: 24000,
        },
      },
    },
  };

  realtimeClient.send({
    type: "session.update",
    session: sessionConfig,
  });

  while (!isConfigured) {
    console.log("Waiting for session.updated event...");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  realtimeClient.send({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Introduce yourself and confirm that the realtime model deployment is working.",
        },
      ],
    },
  });

  realtimeClient.send({
    type: "response.create",
  });

  while (!responseDone) {
    console.log("Waiting for response.done event...");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log("The sample completed successfully.");
  realtimeClient.close();
}

function receiveError(err) {
  if (err instanceof OpenAIRealtimeError) {
    console.error("Received an error event.");
    console.error(`Message: ${err.cause?.message}`);
    console.error(`Stack: ${err.cause?.stack}`);
  } else {
    console.error(err);
  }

  if (throwOnError) {
    throw err;
  }
}

function receiveEvent(event) {
  console.log(`Received an event: ${event.type}`);

  switch (event.type) {
    case "session.created":
      console.log(`Session ID: ${event.session.id}`);
      isCreated = true;
      break;

    case "session.updated":
      console.log(`Session ID: ${event.session.id}`);
      isConfigured = true;
      break;

    case "response.output_audio_transcript.delta":
      process.stdout.write(event.delta);
      break;

    case "response.output_audio.delta": {
      const audioBuffer = Buffer.from(event.delta, "base64");
      console.log(`\nAudio delta length: ${audioBuffer.length} bytes`);
      break;
    }

    case "response.done":
      console.log(`\nResponse ID: ${event.response.id}`);

      const transcript =
        event.response.output?.[0]?.content?.[0]?.transcript;

      if (transcript) {
        console.log(`Final response: ${transcript}`);
      }

      responseDone = true;
      break;

    default:
      console.warn(`Unhandled event type: ${event.type}`);
  }
}

main().catch((err) => {
  console.error("The sample encountered an error:", err);
  process.exitCode = 1;
});
