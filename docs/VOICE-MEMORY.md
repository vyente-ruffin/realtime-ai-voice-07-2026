# Prepared personal memory for voice

Jarvis loads three Hindsight mental models before a voice session: personal facts and relationships, everyday preferences, and current priorities/recent decisions. Personal questions use that context directly; missing details and actual actions retain the existing Hermes delegation path.

## Automatic update flow

1. Direct user speech enters the existing durable retention queue. Assistant guesses are not retained as user facts.
2. Hindsight retains the speech asynchronously and consolidates the extracted facts.
3. Each voice-owned mental model refreshes through Hindsight's native `refresh_after_consolidation` trigger. Refreshes are coalesced with a 300-second minimum interval; completion still depends on Hindsight processing.
4. The app reads the prepared models at startup and every 60 seconds, outside the spoken-response path.
5. Changed sections reach connected browsers through the existing authenticated event stream. The browser passes them through `session.thinking.append`, which supplies quiet context.
6. Each section is deduplicated by its content hash and marked injected only after all its append chunks are acknowledged. Reconnect uses a new startup snapshot and catches up through the event stream.

Current conversation corrections are available immediately, before durable processing finishes. Recent user statements also bridge reconnects. Updates from other Hermes channels arrive once they reach the same Hindsight bank and its summaries refresh. This is an automatic memory update loop, not a system that rewrites its own behavior or treats assistant guesses as truth.

## Boundaries and failure behavior

- Hermes and Hindsight source code, versions, and ordinary memory banks are unchanged. Setup creates/updates only the three named voice summaries using the public Hindsight API.
- Each summary uses a focused question and a small generation limit. Full refresh avoids indefinite growth from repeated incremental edits.
- Oversized, missing, or failed sections keep their last usable cached content and report a health warning. Facts are never silently cut in half.
- Unchanged facts are not injected again on each polling cycle. Each append stays inside the existing 480-byte bound (below the provider's 500-token cap).
- Quiet context is evidence, not instructions. Current explicit user corrections take priority over older summaries. Remembered project status does not prove present service state.
- Acknowledgments describe actual requested work once. Known personal answers have no waiting preface. No classifier or per-turn memory/model call was added.
- Deeper retrieval is not instant. No direct-search router, extra agent, self-tuning prompt, or new memory store was introduced.

## Setup and verification

Run `HINDSIGHT_CONFIG_PATH=/path/to/config.json node scripts/prepare-voice-memory.mjs` before switching `VOICE_MEMORY_MODELS` to `jarvis-voice-profile,jarvis-voice-preferences,jarvis-voice-current`. The command is idempotent and waits for usable content. The old broad model can be retained for rollback with automatic refresh disabled after cutover.

`npm run test:live` checks memory retention, cached context, partial outages, size limits, quiet-update ordering, retries, and reconnect behavior alongside existing voice tests. Real voice checks use the existing audio rig and a separate fictional bank. Confirm accurate spoken answers, no delegation or waiting preface for prepared facts, latency versus the baseline, and actual use of a refreshed fact in an open session. A provider context acknowledgment alone is not proof the model used the fact.

## Sources

- [Hindsight mental models and refresh guidance](https://hindsight.vectorize.io/best-practices#mental-models).
- [Hermes persistent user memory at session start](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
- [Microsoft GPT-Live quiet context updates](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live#add-context-during-the-conversation), verified through Microsoft Learn MCP.
- [GPT-Live delegation instructions](https://developers.openai.com/api/docs/guides/live-prompting#delegation).
