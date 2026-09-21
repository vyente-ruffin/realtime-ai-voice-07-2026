# Jarvis voice implementation

Goal: implement the voice experience plan and scorecard in the current web app; unchanged Hermes/Hindsight source and installed versions.

- Plan: /home/localadmin/hermes-voice-experience-plan-2026-09-20.md
- Scorecard: /home/localadmin/hermes-voice-baseline-scorecard-2026-09-20.md
- Isolated worktree: /home/localadmin/homelab/realtime-ai-voice-live
- Branch: codex/jarvis-live-voice
- Evidence directory: /home/localadmin/voice-implementation-evidence-2026-09-21
- Production code baseline: 9cf7105; production app remains on port 8787.

## Checkpoints

Current status: implementation commit `e4064c0`, voice build `16e4d9aec3807cda`. The existing web app has prepared personal memory, background Hermes jobs, durable conversation history and memory saves. All ten correction cases passed in the original and fresh conversations; 20 task results appeared once; ten final-build reconnects recovered in 1.04–2.76 seconds. The fixed 120-question candidate comparison is complete: typical first sound is 1.11–1.26 seconds, with five attempts timing out under its 20-second window. A long audio-path stall remains unresolved, and interruption and actual phone acceptance are incomplete. Production rollout is not approved by these results. Source and production configuration fingerprints still match the baseline. The private personal preview remains subject to the recorded automatic-approval rejection. See `docs/JARVIS-LIVE-SCORECARD.md` for evidence and limits. The chronological entries below retain earlier results and failures.

1. Done: dependency fingerprints, isolated baseline profile/bank, and received-audio browser recorder.
2. Initial baseline captured: five spoken cases, 4.59–8.28s to first received speech; two seeded facts missed. Full qualification sample still pending.
3. First implementation running on port 8789: GPT-Live, prepared memory, durable jobs/results, asynchronous retention, permissions, reconnect. Nine focused reliability tests pass. Initial candidate answered both seeded facts correctly in 1.12–1.32s; deeper lookup/work tests in progress.
4. Pending: evaluate against the same cases, complete phone/user checks, prepare rollout and rollback.

## Constraints

Keep keyless Azure Entra authentication. No Hermes/Hindsight source patches or upgrades. No live-server restart from the old gate.sh runner. Keep generated audio, credentials, and private memory out of git. Existing community/native integrations are references; supported external interfaces are the connection boundary.

## Runtime and evidence

- Baseline process: `PORT=8788 node talk-server.js`, original behavior, profile `voice-qual-baseline`.
- Candidate process: `PORT=8789 node src/live/server.js`, profile `voice-qual-worker`, model deployment `jarvis-live-qualification` (`gpt-live-1`, 2026-09-10, capacity 10 at the last quota check).
- Synthetic memory bank: `voice-qualification-20260921`; never the personal bank.
- Candidate profile changes only the `agent.environment_hint` into a background-worker contract. Original voice prompt says not to retrieve personal facts and to return async task receipts; that conflicts with the new role. The live profile, model, reasoning level, and recall settings remain unchanged. This prompt change is recorded separately from foreground latency.
- Browser rig: `tests/rig/audio-baseline.mjs`; received PCM and provider transcript events are separate. This is a browser playback proxy, not a physical phone measurement. First sound is not automatically first meaningful answer.
- Evidence subdirectories: `baseline-smoke`, `candidate-smoke`, `candidate-work`.
- The first candidate smoke exposed a SQL placeholder bug on delegation; fixed with 9 passing tests. Its unknown-memory case remains a recorded failure, not a pass.
- Production has not been restarted or changed.

## Scope tightened at the user's request

The user reported low tokens and excessive engineering. Broad benchmark runs and both isolated test services have been stopped. Production was not changed. Do not restart the full qualification suite automatically. The next useful step is one short manual check of conversation, one personal fact, and one background job, followed only by fixing a reproduced defect.

The build is saved, not production-qualified. Eleven focused tests passed. Twenty real Hermes jobs produced correct recorded outcomes. Ten reconnects recovered in 0.96–1.25 seconds when spaced within Azure's measured rate limit. The original spoken-result test repeated old status information; pacing and quiet-context fixes have been written. A subsequent natural-speech pilot still missed a reply and recorded some responses over two seconds. Those issues remain open. Phone checks, interruption measurements, correction persistence and final full fingerprint checks are incomplete.

Last live-tested candidate build: `4d15b181bf26f715`. Private checkpoint: `/home/localadmin/voice-implementation-evidence-2026-09-21/CHECKPOINT.json`. Evidence includes `baseline-latency` (120 attempts), `candidate-latency` (70 diagnostic attempts), `continuity-v2` (20 real jobs/10 reconnects), and `natural-candidate-pilot` (eight recorded attempts, including failures). Earlier failures are retained.

## Focused reconnect fix

The saved natural-speech pilot contains eight completed attempt records. Two lack detected audio: the dog question produced the correct `Pixel.` output transcript, while the city question fell inside a connection outage and produced no input transcript. This narrows the investigation to audio/connection behavior; it does not prove the source of the missing audio or establish that memory caused it. The earlier description of this pilot as stopped/incomplete was inaccurate for these eight attempts.

A separate browser defect is reproduced and fixed: reconnect used to continue while a transcript request was already pending, and it flushed only one older session at a time. It now waits for the existing save and drains the queued conversation text before creating the new voice session. The same offline browser replay fails before the change and passes afterward, with both saved sessions preceding the new session request. No cloud calls or test-service restarts were needed.

Evidence and the replay script are in `/home/localadmin/voice-implementation-evidence-2026-09-21/`: `transcript-reconnect-before.json`, `transcript-reconnect-after.json`, and `voice-transcript-reconnect-check.mjs`. JavaScript syntax and diff checks pass. Production remains unchanged. Missing audio, live latency, and the outstanding acceptance checks remain unresolved; no broad qualification run was restarted.

## Short check and source comparison

One 59-second voice check reused the original driver's Chrome WAV microphone method with native browser recording. No custom audio injection or ScriptProcessor recorder was used. It captured the correct dog answer, a real Hermes calculation, a tea answer while work ran, and one spoken result of 2,870. The opening greeting received no answer or input transcript despite a connected session and outgoing audio; that failure remains unresolved. This is diagnostic evidence, not phone qualification. Artifacts: `native-short-check/` in the private evidence directory. The candidate was stopped afterward; production remains active and unchanged.

That run also reproduced a late queued HTTP response replacing a newer running task update. Browser updates now ignore older task versions; stored update timestamps advance even inside one clock tick. Twelve focused tests and the offline browser ordering replay pass. The voice server also now forwards the Azure retry delay that the browser already understands; it had previously discarded that value. The new rate-limit forwarding has syntax verification, not a repeated live throttle run.

The after-check matches all 14,186 tracked Hermes file hashes, its commit and clean working tree, the Hindsight image identity, its mounted source file, recorded mount identities, and the three production configuration hashes. Docker mount permission fields were not captured in the original baseline and are not claimed verified. Evidence: `dependencies-after-20260921T0305-normalized.json`; the initial raw mount comparison used differently shaped objects and is retained with the correction explained.

The diagnostic before/after measurements and outstanding requirements are summarized in `docs/JARVIS-LIVE-SCORECARD.md`. The last voice-tested build was `58c1861c7c736713`; subsequent changes are the locally verified task-status fix and retry-delay forwarding. No further live voice or broad benchmark run was started.

## Startup alignment and phone-preview approval

The browser now follows the installed Hermes client's bounded ICE gathering step before submitting its connection offer, and avoids injecting an empty task-state update at startup. The local reconnect/status replay passes. In one repeat of the same 59-second native-microphone fixture, the opening greeting, dog answer and tea answer all received transcripts and responses. The explicit calculation request produced an input transcript but no delegation or result; it remains a failed case. This repeat does not qualify reliability or prove the earlier audio failure's cause. Evidence: `native-startup-check/`; voice-tested build `a6e2e68a8f4078fe`. Qualification was stopped afterward.

The delegation policy now names Hermes's backend capabilities and follows the native policy's explicit do/check/find/make/fix/run requests, while preserving direct answers from prepared memory. This last prompt refinement has not had another live run; no new benchmark loop was started.

A private phone preview is prepared in `deploy/live-preview/`. Automatic approval review rejected copying personal memory settings, starting the preview, and exposing its new Tailscale route because that personal-data destination and routing change lacked explicit authorization. None of that rejected command ran. The isolated profile created by the preceding approved CLI command exists. Required next input: explicit approval for the private preview at `https://hermesubuntuv1.tailddc886.ts.net:8443/`, followed by actual microphone feedback. Keep production unchanged and do not work around the rejection.

## Resumed local implementation

The preview-route rejection does not block local implementation or isolated validation. Treating it as a blocker for the whole goal was incorrect. The preview remains disabled pending explicit approval; local work continues under the original plan.

A local regression reproduced a memory-context defect: fragments saved in the same clock tick could be reversed, and previous conversations were concatenated without boundaries. Recent context now preserves fragment order, separates statements and sessions, excludes assistant guesses, and labels older requests as history. Quiet task updates now carry state without broad instructions not to speak or delegate. Thirteen focused tests pass.

The unchanged four-question native microphone check on the resulting build answered the greeting and both prepared facts, delegated the calculation once, answered while it ran, and announced the correct 2,870 result once. The task advanced queued → running → completed with no backward status or recorded connection/application error. Evidence: `native-context-check/`, including the recording, raw events, health/build identity and summary. This is one successful end-to-end case, not a substitute for the original acceptance scorecard.

## Confirmed connection cleanup defect

An offline browser replay reproduced Stop closing the transport before the provider could acknowledge `session.closed`. The voice app now follows the installed Hermes client: release the microphone and mute local playback immediately, wait for the close acknowledgment, and release the transport after a bounded 15-second fallback. The event handler accepts that acknowledgment after the user has stopped. The existing browser runners now use Stop before closing their browser. This is a verified lifecycle defect; it has not been established as the cause of the long live-audio delay. Hermes/Hindsight source and production remain unchanged. Evidence: `close-before.json`, `close-after.json`, and `tests/rig/live-close.mjs`.

Azure request logs are available for the failed-session window, but contain session-initialization records rather than a trace of the delayed voice stream. The corresponding request-duration metrics return no series for this deployment/window. These observations do not identify which side delayed the voice data. Evidence: `azure-stall-requests.json`, `azure-stall-metrics.json`.

The offline close regression fails on the previous code and passes with the fix, including immediate microphone release, provider acknowledgment, and the 15-second fallback. Transcript-save ordering also still passes. One initial live check did not capture a terminal event; that result remains in `close-live.json`. After adding close-request/channel-close diagnostics, the observed live check received `session.closed` with reason `client_request` and released its peer in 533ms (`close-live-observed.json`, build `768d6764e3d31a33`). No speech benchmark was repeated, and this does not establish the cause or resolution of the 79-second delay. The isolated service was stopped afterward; production remains unchanged.

## Requested scope-only acceptance run

Reused the existing older-memory, background-work, follow-up and five interruption cases on build `768d6764e3d31a33`. Correct memory/task answers were recorded, but timing acceptance failed. Corrected the existing interruption runner's overlapping input and made recorded failures produce a failing process exit. No product or upstream code was changed. Results and remaining failures are in `JARVIS-LIVE-SCORECARD.md`, with recordings in `agreed-build-work/` and `agreed-build-interruptions/`. The isolated service is stopped; production is unchanged.

## Original-build setup packaged

The personal-memory/worker installation previously existed as manual steps. It is now implemented in `deploy/live-preview/install.sh` and exposed as `npm run setup:live`. Its default/check mode is read-only. The explicit installation mode uses the supported Hermes CLI and existing Hindsight memory-preparation command, installs the prepared private preview, checks readiness, verifies original configuration and routes, and stops/removes its preview on installation failure. It does not replace production. The script was syntax-checked, its local prerequisite check passed, and the service definition passed systemd validation. The installation mode has not been executed; the recorded destination approval remains unresolved. No voice performance or product behavior was changed during this build step.

## Prompt aligned with the agreed reference

Restored the official guide's required interruption heading and the two separate delegation-condition headings, as already used by native Hermes. The existing memory and work behavior remains the intended scope. Repeated only the same three spoken work cases and five interruption cases; retained the missed follow-up and timing failures. Build `cef1bf62525899d7` is not deployment-qualified. See the scorecard for results and the official source. No further prompt variants or provider changes were tried.
