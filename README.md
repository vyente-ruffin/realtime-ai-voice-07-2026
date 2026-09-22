# Jarvis live voice

## What

A browser voice app that talks directly with Azure GPT-Live while a separate Hermes worker handles background tasks. Personal memory and task outcomes persist locally; existing speech-quality and phone acceptance limits remain in the [qualification record](docs/JARVIS-LIVE.md).

Browser connection/audio diagnostics and browser-local time context are implemented in this checkout but have not been deployed by the observability task.

## Where

- Current app: https://hermesubuntuv1.tailddc886.ts.net/
- Repository: https://github.com/vyente-ruffin/realtime-ai-voice-07-2026
- Active checkout: `/home/localadmin/homelab/realtime-ai-voice-live`
- Entry point: `src/live/server.js`; browser: `web/live.js`
- Personal state: `/home/localadmin/.local/state/jarvis-voice/state.sqlite`
- Runtime: user service `voice-frontend.service`; [deployment and rollback](deploy/live-production/README.md)

## Why

Keep conversation responsive while work runs independently, retain outcomes through reconnects, and keep Azure authentication keyless. Call diagnostics remain local rather than adding a cloud logging dependency.

## How

```text
Browser <-- speech --> Azure GPT-Live
   |                       ^
   +-- local voice server --+ (Entra-authenticated session setup)
            |
            +-- private SQLite: conversation, jobs, audit
            +-- prepared Hindsight memories
            +-- independent Hermes worker
```

Use Node 26+, the installed npm dependencies, signed-in Azure CLI identity for the explicit subscription, and the existing voice-worker/memory configuration described in [the app guide](docs/JARVIS-LIVE.md) and `.env.live.example`. Never put credentials in source.

- Start an appropriately configured instance: `npm run start:live`
- Run isolated tests: `npm run test:live` (browser checks also require the existing Playwright Chromium installation)
- Do not restart the owner's running conversation to try changes.

[Complete configuration, original tutorial, decisions, failures, and verification history](ledger.md)
