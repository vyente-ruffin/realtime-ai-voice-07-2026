# Goal: evidence-backed voice diagnostic coverage

Owner request: V asked Claude Code to fix the identified logging gaps, with a goal prompt and tests that prove the work rather than a completion claim. JARVIS independently verifies the results.

## Outcome

When the voice application is silent or fails, its existing diagnostics must distinguish microphone/permission failures, connection/provider failures, received audio, browser playback state or rejection, telemetry loss/persistence failures, and relevant background-task/memory lifecycle failures. Reuse the existing logger, telemetry and audit storage. Do not add a platform, dashboard or unrelated feature fixes.

## Acceptance and proof

1. Identify the exact missing diagnostic paths in the current active checkout; record what existing events already cover.
2. Add focused failing regression tests before the smallest scoped corrections. Preserve the real pre-fix failure output.
3. Exercise successful browser playback, rejected playback and stalled/ended/muted states as relevant; never equate packet receipt, a playback promise, browser playing state or captured output with physical speaker audibility.
4. Exercise telemetry transport/drop and audit persistence failure paths where missing; failures must leave an observable bounded, redacted diagnostic rather than disappear.
5. Correlate events to a conversation/session or job without logging credentials, raw private speech, personal memories or private host details. Existing intentional transcript storage is unchanged.
6. Run focused tests and the complete npm run test:live suite; preserve actual commands, output and exit codes. Exercise browser paths with the existing isolated harness when applicable.
7. Review the diff, update README and ledger with fixed and remaining gaps, evidence locations, and precise runtime adoption requirements.
8. JARVIS reruns acceptance tests independently and reads the changed implementation; Claude's statement of completion alone is not proof.

## Boundaries

The existing authorized logging repair includes routine reversible edits and isolated tests, not additional owner approval. Preserve pre-existing edits and runtime denials. No Hermes/Hindsight software or profile changes, new spending, installs, destructive cleanup, publication or push. Do not restart production or disturb the active call. Respect the existing idle/release rules; separately report source verification and live adoption. Hardware audibility and provider internals remain explicit limits, not fabricated total coverage.

Active checkout at discovery: /home/localadmin/homelab/realtime-ai-voice-memory; service entry src/live/server.js. Rediscover target before any adoption claim. An existing Claude Code repair worker was verified at PID 636721; do not run a second competing implementation.
