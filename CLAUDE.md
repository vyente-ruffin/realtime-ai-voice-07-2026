# Agent context — realtime-ai-voice-07-2026

Read this first if you're an AI agent (or human) picking this project up. The README is the human tutorial; this file is the working state.

## What this is

A working, verified test harness for a `gpt-realtime-2.1` deployment on Azure AI Foundry:
speech-to-speech over WebRTC in the browser, plus a WebSocket smoke test. Keyless Entra auth only — there are no API keys anywhere in this project, by design. Do not add any.

## Verified state (as of 2026-07-25)

- `voice-test.js` — WORKS. Text prompt → spoken WAV reply (~13s audio, transcript + usage logged as JSON lines).
- `talk-server.js` + `talk.html` — WORKS, human-tested live: mic in, voice out, barge-in interruption (`interrupt_response: true`), transcript freezes at the real cut point on interruption (keyed on `output_audio_buffer.cleared`).
- Session settings panel (server-validated, all clamped in `parseSettings()`): voice picker (10 voices, `cedar` default), persona presets + custom instructions, speed (0.25–1.5), patience (`silence_duration_ms` 200–2000), noise reduction (near/far field), input transcription via whisper-1 ("You:" lines in transcript). UI extras: mute toggle (disables the mic track), live level-bar visualization (Web Audio AnalyserNode on both mic and remote streams). Settings verified server-side; full-loop human voice test of the new panel pending.
- `index.js` — Microsoft's WS quickstart sample, unmodified, also verified working.

## How to rediscover the environment (nothing sensitive is hardcoded here)

The run commands need three values. Re-derive them with az CLI:

```bash
# 1. Find the AIServices resource + its subscription (check ALL subscriptions):
az account list --query "[].id" -o tsv | while read s; do
  az cognitiveservices account list --subscription "$s" \
    --query "[?kind=='AIServices'].{name:name, rg:resourceGroup, sub:'$s'}" -o table
done

# 2. Find the realtime deployment name:
az cognitiveservices account deployment list --subscription <sub> -g <rg> -n <resource> \
  --query "[?contains(properties.model.name,'realtime')].name" -o tsv

# 3. Mint the token (NOTE --subscription, see gotcha #1):
az account get-access-token --subscription <sub> --resource https://ai.azure.com --query accessToken -o tsv
```

Endpoint = `https://<resource-name>.services.ai.azure.com` (or `.openai.azure.com` — both work).

## Gotchas that WILL bite you again (all hit for real; details in README Appendix A)

1. **Tenant trap.** The account here has multiple subscriptions across DIFFERENT tenants, and the az default account is a service principal that does not exist in the resource's tenant. `DefaultAzureCredential` → wrong-tenant token → opaque 400 on the WS handshake. NEVER rely on the az default account; always mint with `--subscription <the-resource's-sub>` and pass it via `AZURE_TOKEN` (both scripts prefer that env var). Setting `AZURE_TENANT_ID` makes it WORSE (AADSTS700016). To diagnose token issues: decode the JWT payload and check `tid`/`upn`/`idtyp`.
2. **`AZURE_TOKEN` expires in ~60–90 min.** Symptom: `/token` returns 502/401. Fix: restart the server with a fresh token. There is no auto-refresh (deliberate — test harness scope).
3. **curl + WebSocket = lie.** Probing the WS endpoint without `--http1.1` gives a fake 404 (HTTP/2 drops the Upgrade header).
4. **Mic errors are usually hardware/context, not code.** `NotFoundError` = no microphone exists (the dev machine is a Mac mini — it has none; a headset must be attached). From another machine, `getUserMedia` needs `https://` or `localhost` (SSH tunnel works).
5. **Voice locks at first spoken word** of a session. Changing voice = new session. The UI already enforces this (dropdown disabled while live).
6. **This project follows engineering standards**: all logging goes through `src/core/logger.js` (never `console.*` in app code), errors from the server are RFC 9457 `application/problem+json`, all I/O has timeouts.

## Architecture in one breath

Browser → local `talk-server.js` (`POST /token`, exchanges real Entra token for a ~1-min ephemeral key via `POST <endpoint>/openai/v1/realtime/client_secrets`, session config incl. voice baked in server-side) → browser opens WebRTC to `<endpoint>/openai/v1/realtime/calls` with the ephemeral key → audio flows on the media track, JSON events on the `oai-events` data channel. GA API surface only: everything under `/openai/v1/`, no `api-version` param.

## Deliberately NOT done (candidate next steps)

- **HTTPS/self-signed cert for the talk server** — so other LAN devices (phones) get mic access without tunnels/flags.
- **Token auto-refresh** in `talk-server.js` (re-mint via `DefaultAzureCredential` on 401, or shell out to az).
- **Audio-file input test** ("speech in, speech out" scripted variant — docs' `audio-in-audio-out` pattern; needs PCM16/24kHz mono input, `ffmpeg -i in.wav -ar 24000 -ac 1 -f s16le in.pcm`).
- **Function calling / tools** during voice sessions — untested here.
- **WebSocket observer** on the WebRTC call (record/steer sessions server-side; see WebRTC how-to Step 3).
- Capacity is 10K TPM (GlobalStandard) — fine for 1 tester, raise before parallel sessions.

## House rules for this repo (from the owner's global standards)

- Leverage battle-tested/official samples before writing new code; cite MS Learn / Context7 docs when adding features.
- Centralized logging via `src/core/logger.{ext}` — creating any new app code? Import from it.
- No changes without the owner's explicit go-ahead; keyless auth only; never commit tokens, keys, `.env`, or audio artifacts.
