# Jarvis voice: measured status

Production is unchanged. The candidate does not pass deployment acceptance. This report summarizes existing evidence; it does not replace the original scorecard or relax its targets.

## Final candidate timing comparison

The same fixed set has 60 attempts per category on each version. Candidate build: `16e4d9aec3807cda` (implementation commit `e4064c0`). These measure end-of-question to first non-silent browser PCM, **not manually aligned meaningful words or physical phone playback**. Median and p95 below use successful attempts; every timeout remains counted separately.

| Question set | Old attempts / timeouts | Old median / p95 | Candidate attempts / timeouts | Candidate median / p95 | Candidate within 2s, all attempts |
| --- | --- | --- | --- | --- | --- |
| Familiar conversation | 60 / 2 | 3.62s / 8.45s | 60 / 3 | 1.11s / 1.47s | 55 / 60 |
| Known memories | 60 / 3 | 3.58s / 7.57s | 60 / 2 | 1.26s / 1.70s | 56 / 60 |

Speed improves, but the original one-second median and 95%-within-two-seconds targets do not pass. Overall timeouts remain 5/120 in each version. The candidate run uses a 20-second timeout. Timeout settings and the raw event windows must be considered when comparing failure counts. Raw data and recordings remain in `baseline-latency/` and `final-latency/`; `final-latency/summary.json` contains every candidate attempt. Earlier development measurements remain in `candidate-latency/`.

One opening greeting in batch 05 never produced an answer during its case window. In batch 10, the provider's media timestamps stopped advancing near 4.6 seconds, and the first output event arrived 79.14 seconds after session start. Four delayed answers then arrived together. The app reported no connection error or delegation during that stall. This is an unresolved audio/transport/provider-path failure, not evidence that Hindsight or Hermes blocked a turn, and not merely missing recorder samples. No speculative retry or provider-setting change was added.

## Experience checks

| Requirement | Current evidence | Acceptance |
| --- | --- | --- |
| Fast start and familiar answers | Fixed final-build set is complete; 1.11s familiar median, but 3/60 familiar timeouts and 5/60 attempts above 2s including failures | Not passed; meaningful-answer and phone measurements also remain |
| Correct prepared memories | Correct tea/dog facts in pilot; native short check captured dog and tea answers | Fixed-set 95% accuracy and unknown-fact review incomplete |
| Corrections persist | All 10 corrections answered correctly immediately and in a fresh browser conversation after storage completed, on build `16e4d9aec3807cda`. All 155 memory operations completed; no unsaved user fragments | Ten scripted content checks pass; physical phone playback remains separate |
| Older memory retrieval | Native microphone check correctly retrieved the Museum of Glass in Tacoma; missing favorite restaurant was reported as unknown | Content checks pass; 5s audible-answer target unverified |
| Interruptions | Five browser trials returned gap measurements of 0ms, no gap, 1,079ms, no gap, and 1,282ms. The runner reported completion, which does not mean the product target passed | 500ms target not established; actual stop/next-answer boundaries require review |
| Conversation during work | Latest four-question native microphone check answered greeting, dog and tea, delegated one calculation, and announced 2,870 once | Demonstrated once on build `d119d0885c9258f5`; required timing distribution missing |
| Results return once | Final-build 20-job run completed every real Hermes task, offered every result once, and produced each correct result once in the voice transcript, with received PCM retained | Twenty outcomes and duplicate suppression pass; 2s audible announcement target still unverified |
| Reconnect | Final build recovered all 10 connections in 1.04–2.76s; all 10 associated real jobs completed, with no duplicate submission detected | Browser recovery passes; actual Wi-Fi/mobile transitions remain untested |
| Everyday phone use | Existing web app retained | Speaker, Bluetooth, screen lock, 30-minute session, and user rating missing |
| Static dependencies | 14,186 Hermes tracked file hashes, commit, Hindsight image/mounted source, mount identities and production config hashes match the baseline | Recorded invariants pass; mount-permission baseline was not captured |

The earlier native short check missed its opening greeting; the startup repeat heard but did not delegate the calculation. Both failures remain in the evidence. The later `native-context-check` answered all four requests and returned the result once after the context and delegation fixes. A connected WebRTC state and sent packets alone do not establish that every turn is answered.

## Fixes verified locally

Reconnect now waits for pending conversation text before opening a new session. A stale queued response no longer overwrites a newer running status. Fourteen focused tests and two offline browser checks pass. They cover ordered memory corrections and prevent a completed memory write from hiding another pending or failed write. These local checks do not count as live speech acceptance. The server now forwards Azure's requested retry delay; a live throttle test has not been repeated.

All evidence is under `/home/localadmin/voice-implementation-evidence-2026-09-21/`. The isolated candidate service was stopped after the final checks. Production remains on its original entry point and deployment. Rollout/rollback steps remain in `docs/JARVIS-LIVE.md`; rollout is conditional on the original acceptance checks passing.

Correction evidence: `corrections/learning/`, `corrections/reconnect/`, and `corrections/summary.json`. The fresh conversation received both the refreshed Hindsight summary and saved recent corrections, as designed. This establishes the combined voice memory path; it does not establish summary-only correction accuracy. The summary still listed both French and Spanish, while recent correction context made the answer Spanish. Saved event transcripts establish answer content; native browser recordings are retained separately.

Final-build task evidence: `final-task-delivery/summary.json`, `results.json`, `events.json`, and `received-audio.wav`. Requests entered through the app API, so this run does not measure spoken request acknowledgement. The repeated source comparison in `dependencies-after-release.json` again matches all tracked Hermes files, commit and working-tree state, the Hindsight image and mounted source, mount identities, and production configuration hashes.

Final continuity evidence: `final-continuity/results.json`, `events.json`, and `received-audio.wav`. The interruption runner waits for any assistant sound, which may be a backchannel before the story-request fixture has ended; overlapping input fixtures can therefore invalidate the attempted interruption. Its `failures: []` means the script finished, not that the interruption target passed. No voice behavior was changed in response to these uncertain measurements.

## Connection shutdown correction

The current voice code additionally fixes Stop closing its connection before waiting for the provider's termination. It follows Hermes's existing graceful-close behavior, stops the microphone and local playback immediately, and falls back after 15 seconds. The offline failure-before/pass-after replay and transcript-save regression pass. The observed live close received `session.closed` and released the connection in 533ms on build `768d6764e3d31a33`. The earlier live attempt without a captured terminal event is retained. See `close-before.json`, `close-after.json`, `close-live.json`, and `close-live-observed.json`. The performance table remains the measurements of build `16e4d9aec3807cda`; the voice-delay cause has not been established.
