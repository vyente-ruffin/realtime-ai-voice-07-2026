# Jarvis live voice candidate

The current web interface now has a GPT-Live connection that can answer from prepared personal memories while Hermes works independently. This is an isolated candidate. Production still runs the original `talk-server.js`.

## Run and check

Use Node 26 or later and the repository's installed dependencies. `npm run start:live` starts `src/live/server.js`; `npm run test:live` runs the focused tests without touching production. Settings are listed in `.env.live.example`. `npm run setup:live -- --check` checks the packaged personal setup; the explicit `--install` mode prepares the separate worker and personal summary, then installs the existing private-preview configuration. Its destination approval and usage are recorded in `deploy/live-preview/README.md`. Azure uses the existing signed-in CLI identity and an explicit subscription. Cloud credentials never reach the browser.

The live server serves the existing `talk.html` markup and styles with `web/live.js`. It does not require rewriting or replacing the web app. The old entry point remains available for rollback.

Before the first personal session, run `node scripts/prepare-voice-memory.mjs` with the intended `HINDSIGHT_CONFIG_PATH`. It provisions the voice-owned `jarvis-voice-context` summary using Hindsight’s native refresh after consolidation, coalesced within five minutes. The app reloads its cached copy every minute. Existing weekly personal/work summaries remain unchanged. Recent spoken corrections bridge the background refresh delay. The setup command waits for usable initial content and can be rerun without creating another summary.

The private voice state file contains conversation fragments, jobs, delivery evidence, and a memory-save queue. Keep it on persistent local storage with a backup. A state file is bound to one Hindsight bank so test memories cannot accidentally become personal context.

## Conversation and work

- GPT-Live answers directly from the conversation and prepared Hindsight mental models. It delegates missing personal facts and actual work through its supported client-delegation events.
- One Hermes ACP worker processes durable jobs. The browser remains available while work runs. Each job retains the conversation snapshot that requested it; later speech cannot silently replace that request.
- Repeated delivery of the same delegation identifier creates one job. A service restart flags unfinished work as needing checking; it does not blindly rerun actions.
- Results are retained and presented on task cards. The voice receives them at a pause. Provider acknowledgments are recorded as context injection, never proof that the result was heard. After an ambiguous disconnect, a result remains available for a status question instead of being repeated blindly.
- Interruption stops speech. The separate Stop task action cancels work. Hermes permission requests appear on task cards and keep their original allowed choices.
- Direct user speech is saved through Hindsight's asynchronous retain API with a stable operation identifier. Assistant guesses are not promoted into user facts. Pending saves survive a restart. Current conversation corrections and recent user statements are supplied on reconnect while durable memory processing completes.

The candidate worker profile is a clone of the voice profile with a background-worker instruction. The old voice instruction told Hermes to answer personal questions without delegating and to return background receipts. That is the wrong role for a worker behind an independently speaking model. This prompt change is separate from the speech/model comparison. The production profile, Hermes source/version, Hindsight image/source, and memory-search settings remain untouched.

## Evidence and remaining gates

The private evidence directory is `/home/localadmin/voice-implementation-evidence-2026-09-21`. Audio is excluded from git. The scorecard is `/home/localadmin/hermes-voice-baseline-scorecard-2026-09-20.md`.

Initial five-case checks found 4.59–8.28 seconds to first received browser speech on the old path. On the first candidate run, the two personal answers were correct and began in 1.12–1.32 seconds; the old path missed both seeded facts. These are pilot samples and a browser playback proxy, not proof of phone latency or final acceptance.

The first candidate lookup failed on a SQL placeholder bug, subsequently fixed and regression-tested. The first uncached-memory fixture exposed an identity mismatch between the fictional test persona and the inherited profile; both test profiles now declare the same test identity. Original failed runs remain in evidence.

The initial Azure test allocation allowed only one session start per minute. Qualification now uses ten, within the resource's existing quota. A reconnect burst can still exhaust this provider limit; the app respects throttling and keeps jobs. The first ten-reconnect burst recorded nine recoveries and a rate-limited timeout. Later runs explicitly record their spacing.

Required before production: full latency samples and failure counts; verified uncached recall and correction persistence; all background outcomes and speech delivery reviewed; interruptions; reconnects; real phone speaker/Bluetooth/lock-screen testing; user rating; dependency fingerprints unchanged. Tests with fake workers verify queue behavior only and are never counted as live speech or task-outcome qualification.

## Rollout and rollback

1. Complete the scorecard and compare the final candidate against the saved baseline. Keep failed and unverified gates visible.
2. Use a separate live worker profile, personal Hindsight configuration, and a fresh personal state file. Never point personal voice at the qualification bank or its state file.
3. Start the candidate on a separate port for phone acceptance. Keep the current front-end service, unit file, Git revision, and Azure deployment recorded.
4. Only after the required gates pass, change the front-end service entry point and its voice-specific settings to the qualified candidate. Hermes and Hindsight remain external services.
5. Roll back by restoring the recorded front-end unit/settings and old entry point. Preserve the candidate state file and show any interrupted work as needing checking; do not replay its actions.

## References used

- [Microsoft GPT-Live WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live-webrtc) and [client delegation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live-delegation), fetched through Microsoft Learn MCP.
- [Hermes native GPT-Live client](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/src/lib/voice-live.ts): connection, transcript fragments, bounded history, quiet progress, commentary, and audio-level observation.
- [Hindsight mental models](https://hindsight.vectorize.io/best-practices#mental-models) and the deployed service's OpenAPI schema: prepared context, asynchronous retention, idempotent operation identifiers, and completion polling.
- [Hermes Voice community app](https://github.com/Cosmekaili-creator/Hermes-Voice): background task/result and phone-session patterns. Its beta status is not treated as production reliability evidence.

Concrete, unapplied cutover and rollback settings are in `deploy/live-production/`; the optional private phone preview remains in `deploy/live-preview/`.
