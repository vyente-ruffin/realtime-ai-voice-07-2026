# GOAL: Repair and Qualify Hermes Voice End-to-End

Restore Hermes Voice so one slow or failed Hermes request can never stop the entire voice conversation. Back up everything first, make only evidence-supported reversible changes, test five complete scenarios through the actual end-user application, and prove the Tailscale path works.

## Sources of truth

- Hermes ACP host integration:
  https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/
- Hermes ACP cancellation:
  https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals/
- Hermes background execution:
  https://hermes-agent.nousresearch.com/docs/reference/tools-reference/
- Production repository:
  `/Users/sudo/GIT/405network/foundry/realtime-audio-quickstart-js`
- Hermes profile:
  `/Users/sudo/.hermes/profiles/voice`
- Application URL:
  `https://sudos-imac.tailddc886.ts.net/`
- Local application:
  `http://127.0.0.1:8787`
- Launchd service:
  `com.405network.talkserver`

## Hard constraints

1. Do not modify anything until all backups are created and verified.
2. Do not update or patch `/Users/sudo/.hermes/hermes-agent`.
3. Do not run `hermes doctor --fix`.
4. Do not expose credentials or print `.env` contents.
5. Do not restore the unrelated Tailscale `:8443` route.
6. Preserve the Tailscale HTTPS root mapping to `127.0.0.1:8787`.
7. Modify the real production files and URL in place—do not build a parallel test application or alternate route.
8. Preserve all pre-existing work. Inspect and record the Git state before editing.
9. Every change must be supported by observed evidence, reversible, and covered by tests.
10. Unit tests, direct ACP requests, direct `/turn` requests, and synthetic protocol traffic may supplement testing but do not satisfy the five end-user tests.
11. Do not attribute application bootstrap, server injections, quoted text, filler, or synthetic tests to V.

## Step 1 — Prove the original failure

Correlate these sources:

- `logs/turns.log`
- `logs/voice-audit.log`
- `logs/turns-routed.log`
- `logs/cancel.log`
- talk-server runtime logs
- `/Users/sudo/.hermes/profiles/voice/state.db`

Prove:

- V’s latency question reached Hermes Voice.
- No final spoken answer returned.
- Later speech continued reaching the application.
- Hermes Voice stopped producing usable spoken replies.
- Cancellation did not restore the conversation.
- Identify the exact failure in the application, ACP client, or session-management path. Do not guess.

## Step 2 — Create and verify backups

Create one timestamped backup directory outside the repository containing:

1. A documented Hermes export of the `voice` profile.
2. A filesystem-safe backup of `/Users/sudo/.hermes/profiles/voice`.
3. `README.md`.
4. All application files that will be modified.
5. `com.405network.talkserver.plist`.
6. Current Tailscale Serve configuration.
7. Pre-change Git status and diff.

For every backup:

- record source and destination;
- generate SHA-256 checksums;
- verify the archive can be listed or extracted into a temporary directory;
- write exact rollback instructions;
- never print secret values.

Stop and report failure if backup verification fails.

## Step 3 — Implement the smallest safe repair

Implement a protected two-lane design:

```text
User speech
    │
    ▼
Foreground conversation ACP
    ├── completes within 15 seconds ──► speak answer
    └── exceeds 15 seconds
             ├──► speak acknowledgment
             ├──► continue work in separate ACP session
             └──► keep a fresh conversation session available
```

Required behavior:

1. Normal answers return through the foreground conversation lane.
2. Work exceeding 15 seconds produces an audible acknowledgment and a real task handle.
3. Long work continues in a separate ACP session or worker.
4. New speech never queues behind long work.
5. Barge-in sends `session/cancel`.
6. Cancellation must produce `stopReason: cancelled`.
7. If cancellation does not complete within a short bounded interval, replace only the stuck ACP worker.
8. Late or cancelled responses must never be spoken.
9. Background completion must return automatically and be spoken when appropriate.
10. Tool failure must produce an explicit spoken failure—not silence.
11. A single failed worker must not restart or disrupt the whole application.

## Step 4 — Preserve conversation provenance

Use these labels:

- `user-authored/app-transcribed`
- `assistant-authored`
- `application bootstrap`
- `system/developer instruction`
- `synthetic test input`
- `synthetic test output`
- `server-injected`
- `tool-generated`
- `quoted material`
- `unknown/needs review`

Explicitly exclude from V’s conversation:

- the `DELEGATION_PREAMBLE` beginning “You are answering by voice…”;
- its acknowledgement;
- `SINS TWIN ONLINE`;
- `PROFILE ROUTE ONLINE`;
- `TAILSCALE VOICE ONLINE`;
- other qualification phrases or injected prompts.

ACP `role=user` alone is not proof that V spoke the text.

## Step 5 — Back up and update README.md

After backing it up, document:

- the real Hermes Voice architecture;
- port `8787`;
- `hermes -p voice acp`;
- foreground versus background ACP behavior;
- 15-second acknowledgment rule;
- cancellation and stuck-worker replacement;
- completion delivery;
- provenance rules;
- logs and troubleshooting;
- the five-test acceptance procedure;
- Tailscale configuration;
- backup and rollback procedure.

## Step 6 — Run five end-user tests

Run every test through the actual browser application at:

`https://sudos-imac.tailddc886.ts.net/`

Automation may drive the browser and microphone, but it must use the real UI, browser microphone/STT path, Hermes processing, and audible TTS output. Do not bypass the application by calling internal endpoints directly.

### Test 1 — Normal conversation

Speak a simple greeting or factual question.

Pass only if:

- transcription is correct;
- Hermes returns a complete answer within 15 seconds;
- the answer is audibly spoken;
- the next turn still works.

### Test 2 — Successful tool-backed question

Ask a question that requires a real read-only tool.

Pass only if:

- tool execution completes;
- Hermes speaks the actual result;
- no unsupported answer is invented;
- the next turn still works.

### Test 3 — Long-running work

Run a real task that lasts longer than 18 seconds.

Pass only if:

- an acknowledgment is spoken within 15 seconds;
- it includes a real task handle;
- the work continues separately;
- the completed result is automatically spoken;
- no result is lost.

### Test 4 — Concurrent speech

While Test 3 is still running, speak an unrelated question.

Pass only if:

- the unrelated question receives a spoken answer within 15 seconds;
- it does not wait behind the long task;
- the original task continues and completes;
- the two answers are not mixed together.

### Test 5 — Failure, cancellation, and recovery

Use a deliberately unavailable resource or safely create a stuck/failing worker, then ask the original model-latency question and a follow-up.

Pass only if:

- the failed operation produces a spoken error or acknowledgment, never silence;
- barge-in cancels or replaces only the affected worker;
- stale output is not spoken;
- the latency question receives a complete spoken answer;
- the follow-up also receives a spoken answer within 15 seconds.

For every test, capture correlated timestamps and receipts from:

- browser/application evidence;
- `turns.log`;
- `voice-audit.log`;
- `turns-routed.log`;
- `background-turns.log`;
- `cancel.log`;
- talk-server runtime logs.

## Step 7 — Verify local, ACP, and Tailscale health

Prove all of the following simultaneously:

1. `http://127.0.0.1:8787` is healthy.
2. Port `8787` is owned by the expected `talk-server.js`.
3. The `hermes -p voice acp` process is a child of that exact listener—not an unrelated ACP process.
4. Tailscale Serve maps:
   `https://sudos-imac.tailddc886.ts.net/`
   to:
   `http://127.0.0.1:8787`
5. The HTTPS page loads successfully.
6. At least one complete microphone-to-transcription-to-Hermes-to-audible-speech exchange succeeds through the Tailscale URL.
7. No unrelated `:8443` route exists.

## Definition of Done

Do not declare success unless:

- backups exist and checksums verify;
- rollback instructions are executable;
- the original failure is explained with raw evidence;
- only reversible, source-backed changes were made;
- README.md is backed up and updated;
- all five end-user tests pass;
- every test includes real spoken output evidence;
- no synthetic or bootstrap traffic is attributed to V;
- local health passes;
- listener-scoped ACP health passes;
- the exact Tailscale HTTPS route passes;
- the real application remains responsive after the adverse test;
- pre-existing repository work is preserved;
- relevant automated tests also pass.

If any required test fails, report FAIL with the exact failed gate and retain or restore the verified backup. Do not claim partial success.

## Final report

Return:

1. Plain-English root cause.
2. Backup paths and checksums.
3. Files changed.
4. Git diff summary.
5. Five-test results with elapsed times.
6. Raw log receipts proving transcription, routing, cancellation, completion, and spoken output.
7. Listener/process-tree proof.
8. Exact Tailscale Serve proof.
9. README.md update summary.
10. Rollback command.
11. Final verdict: `PASS` or `FAIL`.

Do not commit or push until every Definition-of-Done gate passes. If all gates pass, create one focused commit and provide its commit URL.
