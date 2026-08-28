# Deployment on hermesubuntuv1 — 2026-08-28

This file documents how this repo runs on `hermesubuntuv1` (10.69.3.176) after
migration off the retiring Mac mini (`sudos-Mac-mini`, 10.69.3.132). Nothing in
`talk.html` or `talk-server.js` was modified; only environment and the Hermes
`voice` profile were configured.

## Environment

The mini baked the endpoint into `watchdog.sh` rather than a `.env`. Same values
here, exported before `node talk-server.js`:

```bash
HOST=0.0.0.0                       # LAN-visible; mini was loopback + tailscale serve
AZURE_CONFIG_DIR=/home/localadmin/.azure
AZURE_SUBSCRIPTION_ID=e1e5b742-d76b-4ce5-97d3-8d820bb33904   # ME-MngEnvMCAP269813
AZURE_OPENAI_ENDPOINT=https://ai103-resource-ruffin.openai.azure.com
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-realtime-2.1
PATH=/home/localadmin/.local/bin:$PATH                        # hermes CLI
```

`AZURE_SUBSCRIPTION_ID` is mandatory: the az default account here belongs to a
different tenant than `ai103-resource-ruffin` (README Appendix A, gotcha #1).

## Origin allowlist and the microphone

`talk-server.js` `ALLOWED_ORIGINS` accepts only `localhost`/`127.0.0.1` on
`$PORT`, plus any `https://*.ts.net`. Browsing to `http://10.69.3.176:8787`
therefore returns RFC 9457 403 on `POST /token`, and browsers additionally
refuse `getUserMedia` on a non-secure origin. Until Tailscale is installed here,
LAN clients must tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 localadmin@10.69.3.176   # then http://localhost:8787
```

## Hermes `voice` profile

`src/acp-client.js` spawns `hermes -p voice acp` per session. Three deltas from
the mini's profile had to be reproduced here:

1. **`agent.environment_hint`** — copied verbatim from the mini. Without it the
   agent answers as a text agent; with it, replies are 1-3 spoken sentences and
   long work is delegated rather than blocking the turn.
2. **Memory backend** — the mini used Honcho; this host uses Hindsight. The
   voice profile had no `hindsight/config.json`, so every recall and retain
   returned 401 and the agent knew nothing about V. Fixed by copying
   `~/.hermes/hindsight/config.json` into `~/.hermes/profiles/voice/hindsight/`.
3. **No written-reply formatting in memory** — a `Q:/G:` reply-format rule in
   the shared memory bank was recalled into the voice turn and spoken aloud
   verbatim. Reply-style rules must stay out of the memory bank; only facts
   belong there.

## Measured latency (23 turns, this host)

Median 2.2 s, min 1.56 s, max 7.2 s, measured as `turn_ms` in
`logs/turns-routed.log`. Breakdown from `agent.conversation_loop` lines: the
Hermes model call is 1.5-3.0 s of that, with prompt sizes of 27k-47k tokens and
80-86% cache hits. The filler line fires at 4 s, so turns above ~4 s are heard
as "one moment" followed by the answer.

Latency levers, largest first:

| Lever | Effect | Cost |
|---|---|---|
| Smaller model for voice (`claude-haiku-4.5`) | biggest single win; Opus 5 dominates the turn | less capable reasoning |
| Trim recalled memory (currently 57-68 memories, `recall_budget: high`) | prompt grew 27k → 47k tokens across 6 turns | fewer facts available |
| Disable unused MCP servers on the voice profile | 13 tools registered per session at startup | no doc lookups by voice |

Not a lever: the Azure transport. Per Microsoft Learn, WebRTC is already the
lowest-latency option (~100 ms) and is what this app uses; WebSockets would be
~200 ms and SIP higher still.
<https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio>
