/** Isolated HTTP test host: replace only external cloud/memory/worker boundaries. */
import { AzureLive } from "../../src/live/azure.js";
import { VoiceMemory } from "../../src/live/memory.js";
import { VoiceWorker } from "../../src/live/worker.js";
import { randomUUID } from "node:crypto";
AzureLive.prototype.accessToken = async () => "synthetic-test-only";
AzureLive.prototype.session = async function (options) {
  if (options.sdp.includes("synthetic-fail"))
    throw Object.assign(new Error("Azure could not start voice (503)."), { providerStatus: 503, providerRequestId: "synthetic-request" });
  return { session: { id: randomUUID(), testInstructions: options.instructions, testHistory: options.history }, transport: { sdp: "v=0\r\n" } };
};
VoiceMemory.prototype.refresh = async function () { this.prepared = []; };
VoiceMemory.prototype.context = () => "Synthetic fixture; no personal memory.";
VoiceMemory.prototype.drain = async () => {};
process.env.HERMES_API_URL ||= "http://127.0.0.1:1";
VoiceWorker.prototype.resume = async () => {};
VoiceWorker.prototype.kick = async () => {};
await import("../../src/live/server.js");
