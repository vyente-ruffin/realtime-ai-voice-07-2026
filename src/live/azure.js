import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLogger } from "../core/logger.js";
const exec = promisify(execFile);
const logger = await getLogger("live.azure");
export class AzureLive {
  constructor({ endpoint, deployment, subscription }) {
    if (!endpoint || new URL(endpoint).protocol !== "https:")
      throw new Error("An HTTPS Azure endpoint is required.");
    if (!deployment || !subscription)
      throw new Error("Azure deployment and subscription are required.");
    this.endpoint = endpoint.replace(/\/$/, "");
    this.deployment = deployment;
    this.subscription = subscription;
    this.token = null;
    this.expiry = 0;
    this.tokenPromise = null;
  }
  async accessToken(force = false) {
    if (!force && this.token && Date.now() < this.expiry - 300000)
      return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const { stdout } = await exec(
        "az",
        [
          "account",
          "get-access-token",
          "--subscription",
          this.subscription,
          "--resource",
          "https://ai.azure.com",
          "--output",
          "json",
        ],
        { timeout: 12000, maxBuffer: 512000 },
      );
      const value = JSON.parse(stdout);
      this.token = value.accessToken;
      this.expiry = value.expires_on
        ? Number(value.expires_on) * 1000
        : Date.parse(value.expiresOn);
      if (!this.token || !Number.isFinite(this.expiry))
        throw new Error("Azure login returned no usable token.");
      logger.info("Azure login refreshed", {
        expiresAt: new Date(this.expiry).toISOString(),
      });
      return this.token;
    })().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }
  async session({ sdp, voice, instructions, history }) {
    const body = JSON.stringify({
      session: {
        model: this.deployment,
        instructions,
        audio: { output: { voice } },
        delegation: { type: "client" },
        ...(history.length ? { input: history } : {}),
      },
      transport: { type: "webrtc", sdp },
    });
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      response = await fetch(`${this.endpoint}/openai/v1/live/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (response.status !== 401) break;
    }
    if (!response.ok) {
      logger.warn("Azure session rejected", { status: response.status });
      throw Object.assign(
        new Error(`Azure could not start voice (${response.status}).`),
        {
          retryAfterMs:
            response.status === 429
              ? Math.max(
                  1000,
                  Number(response.headers.get("retry-after") || 10) * 1000,
                )
              : 0,
        },
      );
    }
    const value = await response.json();
    if (!value.session?.id || !value.transport?.sdp)
      throw new Error("Azure returned an incomplete voice connection.");
    return value;
  }
}
