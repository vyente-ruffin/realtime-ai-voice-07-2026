# Jarvis voice: measured status

Production is unchanged. The candidate does not pass deployment acceptance. This report summarizes existing evidence; it does not replace the original scorecard or relax its targets.

## Saved diagnostic timings

These are end-of-question to first received sound, **not reviewed first meaningful answers**. Timings below cover successful attempts only; failures remain in separate columns. These runs predate the final candidate and include development changes, so they cannot qualify a single release. Candidate sampling is incomplete.

| Question set | Old attempts / failures | Old median / p95 | Candidate attempts / failures | Candidate median / p95 |
| --- | --- | --- | --- | --- |
| Familiar conversation | 60 / 2 | 3.62s / 8.45s | 35 / 3 | 1.19s / 3.47s |
| Known memories | 60 / 3 | 3.58s / 7.57s | 35 / 3 | 1.31s / 2.60s |

Raw evidence: `/home/localadmin/voice-implementation-evidence-2026-09-21/baseline-latency/` and `candidate-latency/`. No failed attempt was removed from these counts. p95 uses the nearest-rank value among successful timings. Browser recordings do not establish physical phone playback.

## Experience checks

| Requirement | Current evidence | Acceptance |
| --- | --- | --- |
| Fast start and familiar answers | Candidate pilot starts around 1.6s; faster diagnostic replies, with slow/missing responses | Not passed; complete comparable and meaningful-answer measurements missing |
| Correct prepared memories | Correct tea/dog facts in pilot; native short check captured dog and tea answers | Fixed-set 95% accuracy and unknown-fact review incomplete |
| Corrections persist | Durable memory outbox exists; no completed ten-case correction check | Unverified |
| Older memory retrieval | Worker used supported Hindsight recall; earlier identity mismatch was corrected | End-to-end recheck and 5s target unverified |
| Interruptions | Speech and worker cancellation are separate | Required audible stop timing unverified |
| Conversation during work | Native short check answered tea while a real calculation ran | Demonstrated once; required timing distribution missing |
| Results return once | Twenty recorded real jobs completed correctly; earlier spoken run repeated statuses. Latest single-job native check announced 2,870 once | Twenty spoken outcomes on final build not qualified |
| Reconnect | Ten recorded recoveries in 0.96–1.25s within provider quota; transcript-save race fixed locally | Final-build context/action continuity and phone transitions incomplete |
| Everyday phone use | Existing web app retained | Speaker, Bluetooth, screen lock, 30-minute session, and user rating missing |
| Static dependencies | 14,186 Hermes tracked file hashes, commit, Hindsight image/mounted source, mount identities and production config hashes match the baseline | Recorded invariants pass; mount-permission baseline was not captured |

The native short check also missed its opening greeting. A connected WebRTC state and sent packets therefore do not establish that every turn is answered. Do not label the earlier missing sound as merely a test-recorder problem.

## Fixes verified locally

Reconnect now waits for pending conversation text before opening a new session. A stale queued response no longer overwrites a newer running status. Twelve focused tests and two offline browser checks pass. These local checks do not count as live speech acceptance. The server now forwards Azure's requested retry delay; a live throttle test has not been repeated.

All evidence is under `/home/localadmin/voice-implementation-evidence-2026-09-21/`. The candidate service was stopped after the short check. Production remains on its original entry point and deployment. Rollout/rollback steps remain in `docs/JARVIS-LIVE.md`; rollout is conditional on the original acceptance checks passing.
