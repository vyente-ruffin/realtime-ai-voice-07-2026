# Hermes Voice repair qualification — 2026-08-07

## Result

**PASS** — the repaired production deployment completed six browser/microphone-path scenarios after the final code revision. Inputs were generated synthetic audio and are not V's speech.

## Production endpoint

- URL: `https://sudos-imac.tailddc886.ts.net/`
- Serve route: HTTPS `:443` `/` -> `http://127.0.0.1:8787`
- Unrelated `:8443`: absent
- Local and remote HTTP: healthy
- Listener-scoped ACP children after fault recovery: 1
- Deep health: `VOICE_HEALTH_OK local=http://127.0.0.1:8787 remote=https://sudos-imac.tailddc886.ts.net acp=voice deep=1`
- Unauthorized `/turn`: HTTP 403

## End-user scenarios

1. **Normal voice question**
   - STT: `What is 2 plus 2? Answer briefly.`
   - Spoken final: `4`
   - Transcription-to-final-output: 8.38s
   - Capture: `finalq-test1-events.json`
2. **Read-only terminal tool**
   - STT requested the current date/time through the terminal.
   - Spoken final: `It’s Friday, August 7, 2026, at 7:55 AM PDT.`
   - Transcription-to-final-output: 11.29s
   - Capture: `finalq-test2-events.json`
3. **Long work acknowledgement and automatic completion**
   - Real foreground terminal sleep: 18 seconds.
   - `background-turns.log`: accepted at 15.003s, handle `voice-64ce99f7`.
   - Spoken receipt: `Starting that now. Task handle voice-64ce99f7.`
   - Spoken completion: `The long task completed.`
   - Capture: `finalq-test3-events.json`
4. **Unrelated speech while long work remained active**
   - Original 18-second task received a voice handle and later spoke completion.
   - Concurrent STT: `What is 3 plus 3? Answer briefly.`
   - Spoken final: `6`
   - Concurrent transcription-to-final-output: 10.21s.
   - Capture: `finalq-test4-events.json`
5. **Tool unavailable/failing — bounded spoken failure**
   - A foreground 60-second turn was interrupted.
   - `session/cancel` returned `stopReason: cancelled`; stale `forbidden stale reply` was never spoken.
   - A deliberately invalid Hermes command produced the faithful spoken final: `The tool failed because “voice” is not a valid Hermes command.`
   - Server turn time: 5.945s.
   - Capture: `finalq-test5-events.json`
6. **Hung/unresponsive ACP worker replacement**
   - The listener-owned ACP child was deliberately `SIGSTOP`ed during a 60-second turn.
   - `cancel.log`: `completed:false`, `stopReason:timeout`, then `stuck-worker-replaced`.
   - Frozen child was reaped; no stale reply was spoken.
   - Spoken bounded failure: `I hit a snag reaching my brain — one moment.`
   - Follow-up spoken final: `6`; server turn time 12.086s.
   - Capture: `finalq-test6-events.json`

## Automated gates

- Node syntax checks: PASS
- M2 ACP lifecycle tests: PASS
- M4 protected-conversation tests: 17/17 PASS
- Watchdog fail-closed suite: PASS
- Deep live health: PASS
- Exact Tailscale root route: PASS
- Remote HTTPS HTTP 200: PASS
- `:8443` absent: PASS
- Event/audio audit correlation: faithful for final outputs

## Evidence package

- External directory: `/Users/sudo/HermesVoiceBackups/hermes-voice-pre-repair-20260807T135821Z/post-repair-evidence/`
- Archive: `post-repair-evidence.tar.gz`
- SHA-256: `634919b683e94c35b7217d1f386d8bf5ed974ba8bef70ea22539d6225d2c5069`
- Archive listing/extraction check: PASS
- Per-file checksums: `POST-REPAIR-SHA256SUMS`
- Source diff: `post-repair.diff`

## Rollback

Use the exact commands in `/Users/sudo/HermesVoiceBackups/hermes-voice-pre-repair-20260807T135821Z/ROLLBACK.md`. The pre-change archives and copied files were SHA-256 checked and extract-tested before any repair edit.
