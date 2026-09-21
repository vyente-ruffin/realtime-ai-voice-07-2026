# Jarvis voice implementation

Goal: implement the voice experience plan and scorecard in the current web app; unchanged Hermes/Hindsight source and installed versions.

- Plan: /home/localadmin/hermes-voice-experience-plan-2026-09-20.md
- Scorecard: /home/localadmin/hermes-voice-baseline-scorecard-2026-09-20.md
- Isolated worktree: /home/localadmin/homelab/realtime-ai-voice-live
- Branch: codex/jarvis-live-voice
- Evidence directory: /home/localadmin/voice-implementation-evidence-2026-09-21
- Production code baseline: 9cf7105; production app remains on port 8787.

## Checkpoints

1. Done: dependency fingerprints, isolated baseline profile/bank, and received-audio browser recorder.
2. Initial baseline captured: five spoken cases, 4.59–8.28s to first received speech; two seeded facts missed. Full qualification sample still pending.
3. First implementation running on port 8789: GPT-Live, prepared memory, durable jobs/results, asynchronous retention, permissions, reconnect. Nine focused reliability tests pass. Initial candidate answered both seeded facts correctly in 1.12–1.32s; deeper lookup/work tests in progress.
4. Pending: evaluate against the same cases, complete phone/user checks, prepare rollout and rollback.

## Constraints

Keep keyless Azure Entra authentication. No Hermes/Hindsight source patches or upgrades. No live-server restart from the old gate.sh runner. Keep generated audio, credentials, and private memory out of git. Existing community/native integrations are references; supported external interfaces are the connection boundary.

## Runtime and evidence

- Baseline process: `PORT=8788 node talk-server.js`, original behavior, profile `voice-qual-baseline`.
- Candidate process: `PORT=8789 node src/live/server.js`, profile `voice-qual-worker`, model deployment `jarvis-live-qualification` (`gpt-live-1`, 2026-09-10, capacity 1).
- Synthetic memory bank: `voice-qualification-20260921`; never the personal bank.
- Candidate profile changes only the `agent.environment_hint` into a background-worker contract. Original voice prompt says not to retrieve personal facts and to return async task receipts; that conflicts with the new role. The live profile, model, reasoning level, and recall settings remain unchanged. This prompt change is recorded separately from foreground latency.
- Browser rig: `tests/rig/audio-baseline.mjs`; received PCM and provider transcript events are separate. This is a browser playback proxy, not a physical phone measurement. First sound is not automatically first meaningful answer.
- Evidence subdirectories: `baseline-smoke`, `candidate-smoke`, `candidate-work`.
- The first candidate smoke exposed a SQL placeholder bug on delegation; fixed with 9 passing tests. Its unknown-memory case remains a recorded failure, not a pass.
- Production has not been restarted or changed.

## Scope tightened at the user's request

The user reported low tokens and excessive engineering. Broad benchmark runs and both isolated test services have been stopped. Production was not changed. Do not restart the full qualification suite automatically. The next useful step is one short manual check of conversation, one personal fact, and one background job, followed only by fixing a reproduced defect.

The build is saved, not production-qualified. Eleven focused tests passed. Twenty real Hermes jobs produced correct recorded outcomes. Ten reconnects recovered in 0.96–1.25 seconds when spaced within Azure's measured rate limit. The original spoken-result test repeated old status information; pacing and quiet-context fixes have been written. A subsequent natural-speech pilot still missed a reply and recorded some responses over two seconds. Those issues remain open. Phone checks, interruption measurements, correction persistence and final full fingerprint checks are incomplete.

Latest candidate build: `4d15b181bf26f715`. Private checkpoint: `/home/localadmin/voice-implementation-evidence-2026-09-21/CHECKPOINT.json`. Evidence includes `baseline-latency` (120 attempts), `candidate-latency` (70 diagnostic attempts), `continuity-v2` (20 real jobs/10 reconnects), and `natural-candidate-pilot` (stopped, incomplete). Earlier failures are retained.
