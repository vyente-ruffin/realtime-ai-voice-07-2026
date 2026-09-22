# Goal: fast voice with personal memory

Finish and deploy the agreed voice memory improvements. Familiar personal questions should receive direct answers, conversation should stay fast, and memory should update automatically while Hermes handles deeper lookups and background work.

## Current result

The memory update is deployed. The focused memory, reconnect, lookup, background-work, settings, and offline regression checks passed. The existing 500 ms interruption benchmark remains failed; its timing and absence of a timing regression are not established. Earlier audio failures are retained in the private evidence. See `VOICE-MEMORY-VERIFICATION.md` for the public test summary.

## Boundaries

- Do not change Hermes or Hindsight source, installed code, configuration, providers, images, versions, services, or existing summary settings. Do not restart either service.
- Build around their existing APIs and prepared summaries. Normal application memory saves are allowed; fictional test facts belong only in the separate qualification bank.
- Preserve the website, voice settings, interruption behavior, background tasks, stored data, and unrelated uncommitted edits. Do not add a new audio architecture, model, classifier, memory store, or unrelated repairs.

## First step: logging — completed

Review the repository README, ledger, and production deployment notes. Select the reviewed build without silently including unrelated edits. Run `npm run test:live`. Once no voice call or background job is active, back up the voice state and service settings, restart only the voice service, and reload the browser.

Verify a real connect/end cycle sends matching diagnostic records into the existing SQLite audit table and local service log. Include receipt counters and the requested disconnect reason. A muted call avoids test speech and memory writes. Received audio data does not establish audible speech or per-answer latency. This adds records, not a dashboard; Graylog receipt remains unverified. This prerequisite was deployed and verified before the memory update.

## Required outcomes

1. Four recorded questions about known personal facts receive correct spoken answers, with no lookup, delegated job, or waiting phrase.
2. Play questions through the browser microphone and capture returned audio. Compare the same recordings against the baseline; the median response must be no more than 200 ms slower. A transcript without audio fails. This small comparison is not a broad performance guarantee.
3. Save a fictional correction through normal retention. The open session must use it aloud within ten minutes without reload or manual summary refresh; a fresh session must also know it. Check the normal refresh interval without changing protected Hindsight settings, and report any differences between test and production configuration.
4. Retrieve a needed fact absent from the prepared summaries, complete a harmless background task, and keep conversation available. Waiting acknowledgments should fit actual work and occur once. Never invent facts or task status.
5. Run the relevant regression checks, verify settings persistence and interruption behavior, preserve stored data, and keep last-good facts available when refresh fails. Report timing limits separately and honestly.
6. Deploy the tested voice build to the existing private site, verify its health and browser files, and publish code plus non-private documentation to the existing user-owned repository. Keep personal content, recordings, detailed deployment records, and credentials local.

## Execution

Continue from the existing implementation on `codex/jarvis-memory-ready` and the research in `VOICE-MEMORY.md`. Reuse valid evidence and repeat passed checks only when changes or unresolved failures justify it. Only the voice service may be restarted. Preserve rollback settings and current state.

Continue under the authorization already given without asking for the same approval again. Do not relabel failed checks as passing or silently expand scope. If a real blocker cannot be resolved within these boundaries, state the exact failed requirement. Operational evidence remains in the operator's private local state directory.
