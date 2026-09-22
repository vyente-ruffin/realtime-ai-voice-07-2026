/** Isolated HTTP test host: replace only external cloud/memory/worker boundaries. */
import { AzureLive } from "../../src/live/azure.js";
import { VoiceMemory } from "../../src/live/memory.js";
import { VoiceWorker } from "../../src/live/worker.js";
import { randomUUID } from "node:crypto";
AzureLive.prototype.accessToken = async () => "synthetic-test-only";
AzureLive.prototype.session = async function (options) {
  return { session: { id: randomUUID(), testInstructions: options.instructions }, transport: { sdp: "v=0\r\n" } };
};
VoiceMemory.prototype.refresh = async function () { this.prepared = []; };
VoiceMemory.prototype.context = () => "Synthetic fixture; no personal memory.";
VoiceMemory.prototype.drain = async () => {};
VoiceWorker.prototype.warm = async () => {};
VoiceWorker.prototype.kick = async () => {};
await import("../../src/live/server.js");
