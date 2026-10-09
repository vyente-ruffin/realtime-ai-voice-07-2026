# Fix 4 evidence: give honest status

Spec: `docs/VOICE-FIX-PLAN.md`, Fix 4, checks 4a–4e. Build under test for every live run below: `/healthz` buildId `22984f9dc4f39d41` (the commit that adds this file). All live runs were real calls against http://127.0.0.1:8787 in headless Chrome (fake media, Azure Speech TTS utterances), each in its own test conversation, each ending with `scripts/live-e2e/cleanup.mjs` (its `[cleanup]` line is in every output).

**Result: 4a PASS, 4b PASS, 4c PASS, 4d PASS, 4e PASS.**

## What changed

1. **Richer quiet context** (`web/status-context.js`, new, shared by the page and the server). For each running task and each task that ended in the last 30 minutes in this conversation (max 4), one short line: the task name, the state in plain words, minutes elapsed, the latest progress step and, for a task that ended without a result, a plain reason. A header says how many tasks are running, or "No task is running now." Result text is never included (Fix 1). Lines are clipped so a full update stays under ~1,500 characters (the 500-token `session.thinking.append` cap).
   - Task name: `jobs.title`, new column, taken from the newest `user:` line of the request when the job is queued (`store.js`).
   - Latest step: `jobs.progress` / `progress_at`, new columns. `worker.js` turns each Hermes `tool.started` (tool + argument preview, e.g. `running a command (sleep 150)`) and `message.interim` (`said: …`) event into the job's newest step and publishes it. `_thinking` and finished jobs are ignored.
   - Sent again on every job change (state, step, reason), and when the user starts speaking if the minutes have moved since the last send (`web/live.js` `quietJobs()`). The session prompt carries the same status at call start (`policy.js` `speechJobContext()`).
2. **Plain failure reasons** (`worker.js` `reasons`): "You cancelled it." (any run that settles `cancelled`, including one stopped through Hermes `/stop`), "Hermes restarted during this task…" (interrupted / unknown run), "Hermes was busy…" (HTTP 429), "waiting for your approval" + what it asks (approval), "The <tool> step failed…" (a `run.failed` after a `tool.completed` with `error: true`). Raw Hermes error text is only logged. `plainReason()` also replaces any raw-looking error left in older rows ("Internal error", "glitch", "…Error", HTTP codes). The result delivery for an ended task now says it "ended and is no longer running" and passes only the plain reason.
3. **Status speech rule** (`policy.js`, "Status policy"): answer status only from the newest task status; name the task, say state, time and latest step; for an ended task say the reason as written ("You cancelled it", "Hermes restarted during this task"); say plainly when nothing is running; never answer from memory or guesses, never hand status to the backend, never use "nothing solid yet", "internal glitch", "the system ran into"; status updates are silent and never announced unasked.

### Problems found during the live runs and fixed (before the final runs)

- **Unasked status talk (Fix 1 regression), build `b7b11f17a8f798fc`.** The first version re-sent the context every 10 s whenever the minutes changed. In run `fix4-4ab-mv1it52m` the model then spoke unasked at 22:13:23 ("Still running, started about a minute ago…") and 22:14:22 ("Still in that same sleep step, about two minutes in."). Fix: no timed resend; minutes are refreshed when the user starts speaking (microphone energy), the only moment they are used, and the context is labelled "silent update, not a request to speak" plus a speech rule. The final 4a/4b run below has no unasked status speech.
- **Paraphrased reason, build `640270b399e5902a`.** A cancel answer was "It was cancelled…" and the ended-task delivery opened with "Still running." Fix: the rule now says to give the reason as written, and the ended-task delivery says the task "ended and is no longer running".
- **Azure moderation stop, build `cba57933e4ecb019`.** A longer ended-task delivery wording ("…Tell the user once, briefly, … which task it was and this reason as written: …") made Azure end the generation twice ("The generation was stopped due to moderation.", page error at 22:23:31), which dropped the session and reconnected. That wording was reverted to the original Fix 1 sentence shape with only "and is no longer running" added. No moderation error in any final run.
- **Harness:** a reconnect starts a new provider session, so `fix4.mjs` reads fragments by test conversation, and logs page errors; after `systemctl restart` it waits for Hermes `/health` before polling a run.

Observation outside Fix 4's checks (not changed here): some calls still open with a short greeting before the user speaks (e.g. "Hey V, how's your day going?" at 22:24:33). It was also seen in the Fix 3 runs before this fix, and the call-start status is not sent to the page when there are no jobs, so it is not caused by this change.

## Code checks

`npm run -s test:live` after the last code change (Fix 4 tests shown, plus the totals; Fix 1–3 tests unchanged and passing):

```
✔ 4a: a task is named from the user's request and its state and minutes match the job row (152.911602ms)
✔ 4a: task names are short and come from the newest user line (0.554384ms)
✔ 4b: the newest tool.started or message.interim event becomes the task's latest step (113.078744ms)
✔ 4c: a run stopped through Hermes /stop is described as 'you cancelled it' (72.776729ms)
✔ 4c: a gateway restart is described as 'Hermes restarted' (103.553218ms)
✔ 4c: a failed tool is named in plain words; busy and approval have their own plain words (58.127021ms)
✔ 4c: raw error text in an older job row is never passed to the voice (0.42243ms)
✔ 4d: with no running job the context says so plainly, also at call start (0.74834ms)
✔ 4e: the status rule bans the vague phrases and answers only from the task status (0.380042ms)
✔ 4a/4b: the browser sends the status context on every change and refreshes the minutes when the user starts speaking (0.57198ms)
✔ 4a: each task line stays well inside the 500-token quiet-context cap (0.28869ms)
ℹ tests 93
ℹ pass 93
ℹ fail 0
```

## 4a — Status matches reality: PASS

Command: `node scripts/live-e2e/fix4.mjs 4ab` (test run `fix4-4ab-mv1jb50t`). The task is "run the command sleep 150" (over 2 minutes). Questions at 31.8 s (22:26:45.377 − job created 22:26:13.550) and 91.9 s (22:27:45.408 − 22:26:13.550). Each question prints the `jobs` row read the moment the question audio ended (`SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created`) and the quiet status context last sent.

- ~30 s: row `state: running`. Answer: "It's running now—started less than a minute ago, and the sleep 150 command is still in progress." Names the task, says running. ✔
- ~90 s: row `state: running`. Answer: "Still running—about a minute in, doing the sleep command." Names the task, says running. ✔
- No unasked status speech between questions; the only unasked line is this call's own result at 22:28:52 (Fix 1 delivery).

## 4b — Says what it's doing: PASS

Same run. Asked "What are you doing on that?" at 22:26:56.726, after the first tool step (22:26:19.469). The newest Hermes progress event for the run, read from `GET /v1/runs/{id}/events?last_seq=-1` right after the answer, is `tool.started` `terminal` preview `sleep 150` (seq 0, the only progress event). Answer: "I'm still running the sleep command. It just hasn't finished yet." ✔

Full raw output of the 4a/4b run:

```
test run fix4-4ab-mv1jb50t, test conversation 569b2ddf-11be-4a8d-a81a-bdaa01e40e38, session live_EXDKM5kULocGTpx6vsDMI

--- Q (2026-10-09T22:26:13.078Z): Please use the terminal to run the command sleep 150, and tell me when it finishes.
USER (transcribed): Please use the terminal to run the command sleep one hundred fifty and tell me when it finishes
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): No task is running now.
ASSISTANT: Alright.
JOB STARTED 2026-10-09T22:26:13.550Z run run_769ec562d1d14c61ab2827fbbde38e18; first step at 2026-10-09T22:26:19.469Z: running a command (sleep 150)

--- Q (2026-10-09T22:26:45.377Z): How's it going?
USER (transcribed): How’s it going
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[
 {
  "id": "d191d952-4fea-45e1-b872-12e48daa1c0c",
  "state": "running",
  "title": "Please use the terminal to run the command sleep one hundred fifty and tell me…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584779469,
  "run_id": "run_769ec562d1d14c61ab2827fbbde38e18",
  "created": 1791584773550,
  "updated": 1791584779469,
  "error": null
 }
]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): 1 task is running now.
- "Please use the terminal to run the command sleep one hundred fifty and tell me…": running; started under a minute ago; latest step: running a command (sleep 150)
ASSISTANT: It's running now—started less than a minute ago, and the sleep 150 command is still in progress.

--- Q (2026-10-09T22:26:56.726Z): What are you doing on that?
USER (transcribed): What are you doing on that
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[
 {
  "id": "d191d952-4fea-45e1-b872-12e48daa1c0c",
  "state": "running",
  "title": "Please use the terminal to run the command sleep one hundred fifty and tell me…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584779469,
  "run_id": "run_769ec562d1d14c61ab2827fbbde38e18",
  "created": 1791584773550,
  "updated": 1791584779469,
  "error": null
 }
]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): 1 task is running now.
- "Please use the terminal to run the command sleep one hundred fifty and tell me…": running; started under a minute ago; latest step: running a command (sleep 150)
ASSISTANT: I'm still running the sleep command. It just hasn't finished yet.
HERMES EVENTS (GET http://10.69.3.175:8642/v1/runs/run_769ec562d1d14c61ab2827fbbde38e18/events?last_seq=-1, progress kinds only) after the 4b question:
[
 {
  "seq": 0,
  "event": "tool.started",
  "tool": "terminal",
  "preview": "sleep 150",
  "timestamp": "2026-10-09T22:26:19.468Z"
 }
]

--- Q (2026-10-09T22:27:45.408Z): How's it going?
USER (transcribed): How’s it going
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[
 {
  "id": "d191d952-4fea-45e1-b872-12e48daa1c0c",
  "state": "running",
  "title": "Please use the terminal to run the command sleep one hundred fifty and tell me…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584779469,
  "run_id": "run_769ec562d1d14c61ab2827fbbde38e18",
  "created": 1791584773550,
  "updated": 1791584779469,
  "error": null
 }
]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): 1 task is running now.
- "Please use the terminal to run the command sleep one hundred fifty and tell me…": running; started 1 minute ago; latest step: running a command (sleep 150)
ASSISTANT: Still running—about a minute in, doing the sleep command.

TRANSCRIPT (fragments joined per speaker):
2026-10-09T22:26:04.007Z [live_EXDKM5kULocGTpx6vsDMI] assistant: Hey! What's on your mind?
2026-10-09T22:26:08.908Z [live_EXDKM5kULocGTpx6vsDMI] user:  Please use the terminal to run the command sleep one hundred fifty and tell me when it finishes
2026-10-09T22:26:13.807Z [live_EXDKM5kULocGTpx6vsDMI] assistant:  Alright.
2026-10-09T22:26:45.307Z [live_EXDKM5kULocGTpx6vsDMI] user:  How’s it going
2026-10-09T22:26:46.007Z [live_EXDKM5kULocGTpx6vsDMI] assistant:  It's running now—started less than a minute ago, and the sleep 150 command is still in progress.
2026-10-09T22:26:56.507Z [live_EXDKM5kULocGTpx6vsDMI] user:  What are you doing on that
2026-10-09T22:26:57.907Z [live_EXDKM5kULocGTpx6vsDMI] assistant:  I'm still running the sleep command. It just hasn't finished yet.
2026-10-09T22:27:44.807Z [live_EXDKM5kULocGTpx6vsDMI] user:  How’s it going
2026-10-09T22:27:46.207Z [live_EXDKM5kULocGTpx6vsDMI] assistant:  Still running—about a minute in, doing the sleep command.
2026-10-09T22:28:52.008Z [live_EXDKM5kULocGTpx6vsDMI] assistant: V, it's done—sleep 150 finished successfully.
JOBS: [
 {
  "id": "d191d952-4fea-45e1-b872-12e48daa1c0c",
  "state": "completed",
  "title": "Please use the terminal to run the command sleep one hundred fifty and tell me…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584779469,
  "run_id": "run_769ec562d1d14c61ab2827fbbde38e18",
  "created": 1791584773550,
  "updated": 1791584931374,
  "error": null
 }
]
[cleanup] {"run":"fix4-4ab-mv1jb50t","testConversations":1,"hermesSessions":["voice-569b2ddf-11be-4a8d-a81a-bdaa01e40e38-live_EXDKM5kULocGTpx6vsDMI"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-569b2ddf-11be-4a8d-a81a-bdaa01e40e38-live_EXDKM5kULocGTpx6vsDMI":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix4-4ab-1791584953868.json
```

## 4c — Failures in plain words: PASS

### Cancelled via `POST /v1/runs/{id}/stop`

Command: `node scripts/live-e2e/fix4.mjs cancel`. The harness calls Hermes directly (`POST http://10.69.3.175:8642/v1/runs/<run>/stop`, HTTP 200 `stopping`), the run settles `cancelled`, the row gets "You cancelled it. Actions already completed are not undone." Asked "What happened with that task?": **"You cancelled it. It had just started."** No "internal error"/"glitch". ✔ (The automatic one-time delivery of this call's ended task said "That stop request worked; the wait was cancelled, and anything already done stays as is.")

```
test run fix4-cancel-mv1j96z4, test conversation d1a8c6c2-0caa-4d7c-aee2-ca49568d1132, session live_EXDItC7nt2opagLmD7DV0

--- Q (2026-10-09T22:24:42.349Z): Please use the terminal to run the command sleep 150, and tell me when it finishes.
USER (transcribed): Please use the terminal to run the command sleep 150 and tell me when it finishes
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): No task is running now.
ASSISTANT: All right, starting that now.
JOB STARTED 2026-10-09T22:24:42.856Z run run_5c9bf6104e524a2f86744843747d7da0; first step at 2026-10-09T22:24:48.923Z: running a command (sleep 150)

2026-10-09T22:24:49.381Z POST http://10.69.3.175:8642/v1/runs/run_5c9bf6104e524a2f86744843747d7da0/stop -> HTTP 200 {"run_id":"run_5c9bf6104e524a2f86744843747d7da0","status":"stopping"}
HERMES EVENTS: [
 {
  "seq": 0,
  "event": "tool.started",
  "tool": "terminal",
  "preview": "sleep 150",
  "timestamp": "2026-10-09T22:24:48.921Z"
 },
 {
  "seq": 1,
  "event": "tool.completed",
  "tool": "terminal",
  "preview": "{\"output\": \"[Command interrupted]\", \"exit_code\": 130, \"error\": null}",
  "error": true,
  "timestamp": "2026-10-09T22:24:49.619Z"
 },
 {
  "seq": 2,
  "event": "run.cancelled",
  "timestamp": "2026-10-09T22:24:49.628Z"
 }
]
JOB SETTLED 2026-10-09T22:24:49.629Z: {"id":"5a6431f5-24e0-48b5-97cf-8cb8710ed8ee","state":"cancelled","title":"Please use the terminal to run the command sleep 150 and tell me when it…","progress":"running a command (sleep 150)","progress_at":1791584688923,"run_id":"run_5c9bf6104e524a2f86744843747d7da0","created":1791584682856,"updated":1791584689629,"error":"You cancelled it. Actions already completed are not undone."}
HERMES RUN: {"status":"cancelled"}

--- Q (2026-10-09T22:25:07.565Z): What happened with that task?
USER (transcribed): What happened with that task
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[
 {
  "id": "5a6431f5-24e0-48b5-97cf-8cb8710ed8ee",
  "state": "cancelled",
  "title": "Please use the terminal to run the command sleep 150 and tell me when it…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584688923,
  "run_id": "run_5c9bf6104e524a2f86744843747d7da0",
  "created": 1791584682856,
  "updated": 1791584689629,
  "error": "You cancelled it. Actions already completed are not undone."
 }
]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): No task is running now.
- "Please use the terminal to run the command sleep 150 and tell me when it…": cancelled; ran under a minute, ended under a minute ago; reason: You cancelled it. Actions already completed are not undone.
ASSISTANT: You cancelled it. It had just started.

TRANSCRIPT (fragments joined per speaker):
2026-10-09T22:24:33.915Z [live_EXDItC7nt2opagLmD7DV0] assistant: Hey V, how’s your day going?
2026-10-09T22:24:38.114Z [live_EXDItC7nt2opagLmD7DV0] user:  Please use the terminal to run the command sleep 150 and tell me when it finishes
2026-10-09T22:24:43.719Z [live_EXDItC7nt2opagLmD7DV0] assistant:  All right, starting that now.
2026-10-09T22:24:50.714Z [live_EXDItC7nt2opagLmD7DV0] assistant: That stop request worked; the wait was cancelled, and anything already done stays as is.
2026-10-09T22:25:06.814Z [live_EXDItC7nt2opagLmD7DV0] user:  What happened with that task
2026-10-09T22:25:08.914Z [live_EXDItC7nt2opagLmD7DV0] assistant:  You cancelled it. It had just started.
JOBS: [
 {
  "id": "5a6431f5-24e0-48b5-97cf-8cb8710ed8ee",
  "state": "cancelled",
  "title": "Please use the terminal to run the command sleep 150 and tell me when it…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584688923,
  "run_id": "run_5c9bf6104e524a2f86744843747d7da0",
  "created": 1791584682856,
  "updated": 1791584689629,
  "error": "You cancelled it. Actions already completed are not undone."
 }
]
[cleanup] {"run":"fix4-cancel-mv1j96z4","testConversations":1,"hermesSessions":["voice-d1a8c6c2-0caa-4d7c-aee2-ca49568d1132-live_EXDItC7nt2opagLmD7DV0"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-d1a8c6c2-0caa-4d7c-aee2-ca49568d1132-live_EXDItC7nt2opagLmD7DV0":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix4-cancel-1791584718401.json
```

### Hermes restarted (`systemctl --user restart hermes-gateway.service` during the test job)

Command: `node scripts/live-e2e/fix4.mjs restart`. The restart was issued 6 s after the job's first tool step; `systemctl restart` took 33.4 s and Hermes `/health` answered again 49.4 s after it began. Hermes persisted the run as `interrupted` ("Gateway shutdown interrupted the run." — logged only), the row got "Hermes restarted during this task, so it stopped part way. It was not run again." Asked "What happened with that task?": **"It started, but Hermes restarted, so it stopped part way. It wasn't retried."** No "internal error"/"glitch". ✔

```
test run fix4-restart-mv1jfdav, test conversation 56d33616-e45e-4243-a17f-9f84f726205e, session live_EXDNXtq4EJv4obTMTgryr

--- Q (2026-10-09T22:29:30.500Z): Please use the terminal to run the command sleep 150, and tell me when it finishes.
USER (transcribed): Please use the terminal to run the command sleep 150, and tell me when it finishes
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): No task is running now.
ASSISTANT: Alright, starting that now.
JOB STARTED 2026-10-09T22:29:30.814Z run run_d06eed5e5a8c4314895d2cfd41c18ddc; first step at 2026-10-09T22:29:36.865Z: running a command (sleep 150)

2026-10-09T22:29:37.017Z systemctl --user restart hermes-gateway.service -> done in 33372 ms
active
2026-10-09T22:30:26.433Z Hermes /health ok again (49416 ms after the restart began)
JOB SETTLED 2026-10-09T22:30:08.647Z: {"id":"7cf08334-cf7b-428f-a1e8-9320dd37ed09","state":"interrupted","title":"Please use the terminal to run the command sleep 150, and tell me when it…","progress":"running a command (sleep 150)","progress_at":1791584976865,"run_id":"run_d06eed5e5a8c4314895d2cfd41c18ddc","created":1791584970814,"updated":1791585008647,"error":"Hermes restarted during this task, so it stopped part way. It was not run again."}
HERMES RUN: {"status":"interrupted","error":"Gateway shutdown interrupted the run."}

--- Q (2026-10-09T22:30:43.288Z): What happened with that task?
USER (transcribed): What happened with that task
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[
 {
  "id": "7cf08334-cf7b-428f-a1e8-9320dd37ed09",
  "state": "interrupted",
  "title": "Please use the terminal to run the command sleep 150, and tell me when it…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584976865,
  "run_id": "run_d06eed5e5a8c4314895d2cfd41c18ddc",
  "created": 1791584970814,
  "updated": 1791585008647,
  "error": "Hermes restarted during this task, so it stopped part way. It was not run again."
 }
]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): No task is running now.
- "Please use the terminal to run the command sleep 150, and tell me when it…": stopped part way; ran under a minute, ended under a minute ago; reason: Hermes restarted during this task, so it stopped part way. It was not run again.
ASSISTANT: It started, but Hermes restarted, so it stopped part way. It wasn’t retried.

TRANSCRIPT (fragments joined per speaker):
2026-10-09T22:29:26.284Z [live_EXDNXtq4EJv4obTMTgryr] user:  Please use the terminal to run the command sleep 150, and tell me when it finishes
2026-10-09T22:29:31.184Z [live_EXDNXtq4EJv4obTMTgryr] assistant:  Alright, starting that now.
2026-10-09T22:30:09.684Z [live_EXDNXtq4EJv4obTMTgryr] assistant:  Okay, that run stopped part way because Hermes restarted. It wasn’t run again.
2026-10-09T22:30:42.584Z [live_EXDNXtq4EJv4obTMTgryr] user:  What happened with that task
2026-10-09T22:30:43.986Z [live_EXDNXtq4EJv4obTMTgryr] assistant:  It started, but Hermes restarted, so it stopped part way. It wasn’t retried.
JOBS: [
 {
  "id": "7cf08334-cf7b-428f-a1e8-9320dd37ed09",
  "state": "interrupted",
  "title": "Please use the terminal to run the command sleep 150, and tell me when it…",
  "progress": "running a command (sleep 150)",
  "progress_at": 1791584976865,
  "run_id": "run_d06eed5e5a8c4314895d2cfd41c18ddc",
  "created": 1791584970814,
  "updated": 1791585008647,
  "error": "Hermes restarted during this task, so it stopped part way. It was not run again."
 }
]
[cleanup] {"run":"fix4-restart-mv1jfdav","testConversations":1,"hermesSessions":["voice-56d33616-e45e-4243-a17f-9f84f726205e-live_EXDNXtq4EJv4obTMTgryr"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-56d33616-e45e-4243-a17f-9f84f726205e-live_EXDNXtq4EJv4obTMTgryr":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix4-restart-1791585055098.json
```

## 4d — Correct when nothing is running: PASS

Command: `node scripts/live-e2e/fix4.mjs 4d`. `SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','awaiting_permission')` = 0 at the question and after the answer (whole table, not only the test conversation). Asked "Is anything running?": **"No, nothing's running right now."** ✔

```
test run fix4-4d-mv1jac1t, test conversation 9d47fbf1-14b6-41be-9c8e-0cf7ca7095dc, session live_EXDJlgKdGSG4he1iERP6Q

--- Q (2026-10-09T22:25:34.909Z): Is anything running?
USER (transcribed): Is anything running
JOBS ROW AT QUESTION END (SELECT id,state,title,progress,progress_at,run_id,created,updated,error FROM jobs WHERE conversation=? ORDER BY created):
[]
QUIET STATUS CONTEXT LAST SENT:
Task status from the app (silent update, not a request to speak; use it only when the user asks about status): No task is running now.
ASSISTANT: No, nothing’s running right now.

SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','awaiting_permission') -> at question end 0, after answer 0

TRANSCRIPT (fragments joined per speaker):
2026-10-09T22:25:34.891Z [live_EXDJlgKdGSG4he1iERP6Q] user:  Is anything running
2026-10-09T22:25:35.591Z [live_EXDJlgKdGSG4he1iERP6Q] assistant: No, nothing’s running right now.
JOBS: []
[cleanup] {"run":"fix4-4d-mv1jac1t","testConversations":1,"hermesSessions":[],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix4-4d-1791584757923.json
```

## 4e — Banned vague phrases: PASS

Command: `node scripts/live-e2e/fix4.mjs 4e <ids>` over every test conversation made by Fix 4 runs (`SELECT id FROM conversations WHERE test LIKE 'fix4-%'`: 14 conversations, including the earlier builds' runs above). Zero hits in 439 assistant fragments.

```
SQL: SELECT f.session,f.at,f.text FROM fragments f WHERE f.role='assistant' AND f.conversation IN (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ORDER BY f.at,f.rowid
ARGS: ["2182f714-c97e-4fe4-ae48-ca9df558e294","b2952497-0f3b-45b1-bd6a-7190dcfdfa83","2caa0372-2974-4977-a13f-897e1a33a87e","5ca11366-6062-4fd9-86d6-39acd8eb46a6","96ef0c7c-25a3-4b45-958f-4ddd9064c1b6","47c14092-dfc8-4329-941f-3cd759850300","afdbde4e-2d1a-475a-a0e6-1fd7748fdb09","46f84ee4-6d18-4d3d-8946-885277c9fbce","a3c399c6-72e4-4894-ba54-bdc96bf41991","6f1f5803-3eff-40e3-a5d8-1c04ebe18245","d1a8c6c2-0caa-4d7c-aee2-ca49568d1132","9d47fbf1-14b6-41be-9c8e-0cf7ca7095dc","569b2ddf-11be-4a8d-a81a-bdaa01e40e38","56d33616-e45e-4243-a17f-9f84f726205e"]
assistant fragments: 439 in 16 sessions
banned pattern: /nothing solid yet|internal glitch|the system ran into/i
sessions with hits: 0

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix4-4e-1791585063881.json
```

## Isolation: V's real conversation untouched

Every run printed `[isolation] owner conversation new fragments: 0` and its `[cleanup]` report (above: no memories found or left valid, no recall hits, no prepared-memory or MEMORY.md/USER.md hits). Direct query on V's conversation since before the first Fix 4 run (21:55 UTC):

```
SQL: SELECT COUNT(*) AS n, MAX(at) AS last FROM fragments WHERE conversation=? AND at>=? ARGS: ["ccad5a2f-2433-4361-bfc8-bba14d7973e9",1791582900000]
[{"n":0,"last":null}]
default-conversation cache: "ccad5a2f-2433-4361-bfc8-bba14d7973e9"
```

## Data safety

- `~/.local/state/jarvis-voice/state.sqlite` was backed up to `state.sqlite.20261009T220220Z` (same folder, mode 600) before the first restart that added the `title`, `progress`, `progress_at` columns. Existing rows are untouched; old jobs get their name from their request when shown.
- `voice-frontend.service` was restarted only when `SELECT state,COUNT(*) FROM jobs WHERE state IN ('queued','running','awaiting_permission')` returned no rows (`[]` before each restart).
- `hermes-gateway.service` was restarted only inside the two restart test runs, each while only the test job was running; it was `active` and `/healthz` was `ready` afterwards.
- Hermes and Hindsight source were not edited.
