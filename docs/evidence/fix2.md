# Fix 2 evidence: make it the same JARVIS

Spec: `docs/VOICE-FIX-PLAN.md`, Fix 2, checks 2a–2g.

## What changed

- `src/live/worker.js` no longer starts a Hermes ACP child. Each job is a run on the main Hermes API server inside `hermes-gateway.service` (`HERMES_API_URL`, default `http://10.69.3.175:8642`). The key is read from `API_SERVER_KEY` in `~/.hermes/.env`; only that one line is read.
  - Start: `POST /v1/runs` with `input` = the job's request, `instructions` = the worker prompt (`workerInstructions` in `policy.js`), `session_id` = `voice-<conversation>`, header `Idempotency-Key: <job id>`, and header `X-Hermes-Session-Key: voice:<conversation>`.
  - Follow: `GET /v1/runs/{id}/events`. If the stream breaks, it polls `GET /v1/runs/{id}` until Hermes answers, then resumes from `last_seq`. Stop: `POST /v1/runs/{id}/stop`. Approvals: `approval.request` events show in the task card, and the choice goes to `POST /v1/runs/{id}/approval`.
  - The run id and Hermes session are stored on the job (`jobs.run_id`, `jobs.hermes_session`; the columns are added on start).
- There is no local queue. Every queued job starts at once. HTTP 429 fails the job with "I'm at capacity: Hermes is already running as many tasks as it allows…", and that is spoken like any other result from this call. Failures use plain words: Hermes restarted, could not finish, could not be reached, or stopped at your request. Raw Hermes error text is logged, never spoken.
- Restarting the voice service no longer abandons work. Jobs with a run id are followed again (`worker.resume()`). Only jobs that never reached Hermes are marked interrupted.
- `/healthz` checks Hermes `GET /health` (`{"status":"ok"}`) and Hindsight `GET /health` on every request. It says `ready` only when both answer. Otherwise it says `degraded` and names the service that is down in `down`.
- Memory: the default and the `voice-frontend.service` drop-in now use `HINDSIGHT_CONFIG_PATH=/home/localadmin/.hermes/hindsight/config.json` (main profile, bank `hermes`, `auto_recall: true`). `deploy/live-production/voice-frontend-live.conf` matches the live drop-in. `hermes-gateway-voice.service` was left running (plan item 5).

**One change from the plan's wording (Hermes behaviour, measured).** The plan asks for one `session_id` per voice conversation, and for jobs to run side by side. Hermes runs one turn at a time per session ("Session turn leases serialize concurrent writers", api-server.md, `POST /v1/runs`). I measured this on the live gateway before writing code. Same `session_id`: run B (a one-word reply) waited for run A (`sleep 45`):

```
0s A=running B=running
...
46s A=running B=running
49s A=completed B=running
52s A=completed B=completed
```

Different `session_id` values: B finished in 3 s while A ran:

```
0s A=running B=running
3s A=running B=completed
...
52s A=completed B=completed
```

So a job uses `voice-<conversation>` when no other job of that conversation is in flight. A job started next to a running one gets its own lane, `voice-<conversation>-<first 8 chars of job id>`. Both carry the same `X-Hermes-Session-Key`. 2f shows both forms in use, and 2b shows that Hermes reports the same session ids.

## How the checks were run

- **Restart rule.** Before restarting the voice service, the jobs table held no active rows:
  ```
  [ { state: 'completed', n: 90 }, { state: 'failed', n: 3 } ]
  ```
  Before `hermes update`, the active-job count was `{ n: 0 }`. 2g checks the same thing in code before it stops the gateway.
- **Backup before the data change** (new job columns): `~/.local/state/jarvis-voice/state.sqlite.20261009T193528Z.bak` (node:sqlite online backup, 776 pages, mode 600). The old drop-in was backed up to `~/.local/state/jarvis-voice/50-jarvis-live.conf.<UTC>.bak`.
- **Deploy.** I edited the drop-in, then ran `systemctl --user daemon-reload` and `systemctl --user restart voice-frontend.service`. Health right after:
  ```
  {"status":"ready","down":[],"hermes":{"ok":true},"hindsight":{"ok":true},"voice":"gpt-live","buildId":"085093b6deca64de","preparedMemories":3,"memoryWarning":null,"runningJobs":0,"memorySaves":[{"state":"completed","count":169}],"uptimeSeconds":6}
  ```
- **Live runs.** `node scripts/live-e2e/fix2.mjs <check>` reuses `scripts/live-e2e/harness.mjs` from Fix 1. It drives the real page at http://127.0.0.1:8787 in headless Chrome (`/usr/bin/google-chrome`, Playwright) with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<silent 48 kHz WAV>`. Spoken requests are Azure Speech 48 kHz mono PCM WAVs made with the keyless `az` login and mixed into the fake microphone. Every request in 2c–2f was spoken; none were typed. Pass/fail comes from read-only queries on `~/.local/state/jarvis-voice/state.sqlite` and from the Hermes Runs API. Raw JSON for each run is in `logs/live-e2e/fix2-*.json` (git-ignored).
- **Code checks.** `npm run -s test:live`, final run after the last change:
  ```
  ✔ 2a: the worker has no Hermes child process or ACP client (1.729591ms)
  ✔ 2a: the running voice server process has no child processes (1223.023948ms)
  ✔ 2b: a job starts a Hermes run with the documented fields and stores its run id (107.540544ms)
  ✔ 2b: a retried start reuses the Idempotency-Key, so Hermes never runs the job twice (44.852909ms)
  ✔ 2c: memory defaults to the main profile's Hindsight config and the shipped drop-in uses it (1.309056ms)
  ✔ 2d: a broken event stream is followed by status polling, not a failed job (98.74138ms)
  ✔ 2e: a gateway restart settles the job as interrupted in plain words, with no result (88.53702ms)
  ✔ 2e: a run Hermes no longer knows is interrupted, and a delivered interruption is never offered again (15.868849ms)
  ✔ 2e: a voice service restart reattaches to runs in flight instead of abandoning them (21.696361ms)
  ✔ 2f: jobs run side by side; a quick one finishes while a long one is still running (39.378825ms)
  ✔ 2f: twenty jobs start without a local queue (141.109246ms)
  ✔ 2f: HTTP 429 tells the user Hermes is at capacity instead of queueing quietly (31.324064ms)
  ✔ cancel stops the Hermes run and a late completion cannot overwrite it (30.140672ms)
  ✔ approvals come from Hermes approval.request and go back to /approval for the right job only (35.54614ms)
  ✔ a failed run is described in plain words, never raw Hermes error text (37.707131ms)
  ✔ 2g: /healthz is ready only when Hermes and Hindsight both answer, and names the one down (504.2172ms)
  ℹ tests 70
  ℹ pass 70
  ℹ fail 0
  ```
  The suite includes all Fix 1 tests (`tests/live/delivery.test.mjs`), which still pass. The old ACP worker tests in `reliability.test.mjs` and `observability.test.mjs` were replaced by Runs API versions. The one-at-a-time test (`max === 1`) encoded the behaviour this fix removes.

---

## 2a: No private Hermes — PASS

Run on 2026-10-09T20:02:47Z, after every live check, including the Hermes update and the gateway restarts:

```
$ ps -o pid,args -p $(systemctl --user show -p MainPID --value voice-frontend.service)
    PID COMMAND
1632329 /home/localadmin/.local/bin/node src/live/server.js
$ ps --ppid $(systemctl --user show -p MainPID --value voice-frontend.service) -o args
COMMAND
exit=1
```

No processes are listed, so there is no `hermes` or `acp` child. It was the same right after deploy at 19:35 (`COMMAND`, exit=1).

## 2b: Jobs are real Hermes runs — PASS

`node scripts/live-e2e/fix2.mjs 2b` covers every voice job from every Fix 2 test call (sessions recorded in `logs/live-e2e/fix2-sessions.json`). It reads the job rows, then calls `GET /v1/runs/{run_id}` on `http://10.69.3.175:8642` with the key.

```
=== 2b PASS 7/7 jobs have a run id with matching Hermes status
SQL: SELECT id,session,state,run_id,hermes_session FROM jobs WHERE session IN (?,?,?,?,?,?,?) ORDER BY created  -- then GET /v1/runs/{run_id} for each
ARGS: ["live_EXAicnf8O89hVG0PstW5N","live_EXAkPGsu97Gm8JcFJV4O4","live_EXAqDr56J87UnW4bgQmRa","live_EXAujScFp7hKaFXMw5WCU","live_EXB1LgRlQQadJx13fH49k","live_EXB3UYyzC0njD87VAg8VU","live_EXB4mL6Xte6JIkDfkP7LJ"]
ROWS:
job 01877ef3-…  state completed   run_9e5fc5f646874438a084eafa5cc8e141  http 200  hermes_status completed   hermes_session_id voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9           matches true
job 028c3553-…  state completed   run_5cfda263cfb84eb3b99227bb369ebdf0  http 200  hermes_status completed   hermes_session_id voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9           matches true
job 326f00f8-…  state completed   run_79bd97e3ecde41c2b3850ddfaae904bd  http 200  hermes_status completed   hermes_session_id voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9           matches true
job 0f79cdfa-…  state completed   run_2e984b7d194a4cebbd906aaa0b364e9b  http 200  hermes_status completed   hermes_session_id voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9-0f79cdfa  matches true
job 3beb2029-…  state completed   run_1d041085a41c4dbdbc4b9839104b9018  http 200  hermes_status completed   hermes_session_id voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9           matches true
job dce6ea71-…  state completed   run_d65699d1a1e5402584289481000c8f8f  http 200  hermes_status completed   hermes_session_id voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9           matches true
job abc57527-…  state interrupted run_6209e561b2cd4fe18de8881cd2cd1483  http 200  hermes_status interrupted hermes_session_id voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9           matches true
```

The rows above are the script's JSON, one row per job with the same fields. The full JSON is in `logs/live-e2e/fix2-2b-1791576162520.json`. Run statuses survived the `hermes update` restart and the 2e gateway restart, because runs started with an `Idempotency-Key` are stored durably.

## 2c: Same memory as Telegram — PASS

**How the fact was told.** I used a one-shot turn on the main Hermes profile instead of a Telegram message. It is the same `default` profile and the same Hindsight bank (`hermes`) that Telegram uses. Word chosen at random: `quokka`.

```
$ date -u; hermes -z "Remember this: my test word is quokka."; date -u
2026-10-09T19:36:12Z
G: Save it for future recall.

Saved, V: your test word is quokka.

R: none — no supporting source
2026-10-09T19:36:33Z
```

Hindsight recall straight after (`POST /v1/default/banks/hermes/memories/recall`, query "what is my test word") returned only the new fact, with no older test words:

```
2026-10-09T19:36:30+00:00 | V's test word is "quokka."
2026-10-09T19:36:21+00:00 | V's test word is "quokka."
2026-10-09T19:36:21+00:00 | V's test word is "quokka." | Involving: V
2026-10-09T19:36:30+00:00 | The user's test word is "quokka." | Involving: user | For future recall.
(the remaining results were unrelated "test" memories from August–September)
```

**Asked by voice more than 10 minutes later.** `node scripts/live-e2e/fix2.mjs 2c quokka "Jarvis, what's my test word?"`, asked at 19:51:35Z:

```
=== 2c PASS test word "quokka"; assistant said: "Hmm, let's see.  Your test word is quokka."
SQL: SELECT role,text,at FROM fragments WHERE session=? AND at>=? ORDER BY at,rowid
ARGS: ["live_EXAujScFp7hKaFXMw5WCU", 1791575495721]
2026-10-09T19:51:35.409Z user "Jarvis"
2026-10-09T19:51:36.109Z user ", what's"
2026-10-09T19:51:36.112Z user " my"
2026-10-09T19:51:36.113Z user " test"
2026-10-09T19:51:36.502Z user " word"
2026-10-09T19:51:37.511Z assistant "Hmm,"
2026-10-09T19:51:37.514Z assistant " let's"
2026-10-09T19:51:37.515Z assistant " see"
2026-10-09T19:51:38.210Z assistant "."
2026-10-09T19:51:49.409Z assistant " Your test"
2026-10-09T19:51:50.109Z assistant " word"
2026-10-09T19:51:50.111Z assistant " is"
2026-10-09T19:51:50.809Z assistant " quokka"
2026-10-09T19:51:50.811Z assistant "."
jobs: [{"id":"3beb2029-0856-485b-af30-8df62342051e","state":"completed","run_id":"run_1d041085a41c4dbdbc4b9839104b9018","hermes_session":"voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9","created":1791575496506,"updated":1791575508695,"result":"Your test word is quokka, V."}]
```

The word came from a main-profile Hermes run (12 s), not from the voice model's own context.

**Earlier attempt (FAIL, kept for the record).** At 19:46:51Z the first attempt asked "What's my test word?" 2 s after connecting. GPT-Live created no job, stayed silent for almost 3 minutes, then produced garbled text. The app logged nothing wrong, and the audit trail shows only `call.stats`.

```
=== 2c FAIL test word "quokka"; assistant said: " एमयोट्रिक्स"
2026-10-09T19:46:50.661Z user " What's" … 19:46:51.362Z user " word"
2026-10-09T19:49:38.661Z assistant " एमय" "ोट्र" "िक्स"
jobs: []
```

The retry waited 5 s after connecting and started with "Jarvis,". No code changed between the two attempts.

## 2d: Survives a Hermes update — PASS

`hermes update` was run with its normal command. An update was available (`hermes update --check`: "Update available: 48 commits behind origin/main"), so no gateway-restart substitution was needed.

First attempt, 19:52:13Z, failed inside Hermes' own git step:

```
→ Fetching updates...
✗ Update failed: Command '['git', '-c', 'gc.autoDetach=false', '-c', 'maintenance.auto=false', 'cat-file', '--batch']' timed out after 120 seconds
exit=1
```

Retry with the same command, 19:54:23Z to 19:58:05Z:

```
✓ Update complete! (v0.21.6+301.g8bff64d.dirty → v0.21.6+349.g3637c51.dirty) [main @ 3637c512fc]
Fleet version check:
  ✓ default (pid 1654480) @ 3637c512 — up to date
  … (coder, finance, homelab-it, microsoft-engineer, orchestrator, researcher, voice — all @ 3637c512)
exit=0
```

The gateway came back (`ActiveEnterTimestamp=Fri 2026-10-09 19:56:29 UTC`; `GET /health` → `{"status": "ok", "platform": "hermes-agent", "version": "0.21.6"}`). The voice service was **not** restarted: same process, `uptimeSeconds: 1356`.

Then `node scripts/live-e2e/fix2.mjs 2d` sent a spoken task that needs a tool: "Please check how much free disk space the root filesystem on this server has right now."

```
=== 2d PASS jobs created=1; state=completed
SQL: SELECT id,state,run_id,created,updated,substr(result,1,300) AS result,error FROM jobs WHERE session=? AND created>=?
ARGS: ["live_EXB1LgRlQQadJx13fH49k", 1791575904963]
ROWS: [{"id":"dce6ea71-c71f-4f2a-bffa-a52f5292ccb8","state":"completed","run_id":"run_d65699d1a1e5402584289481000c8f8f","created":1791575905316,"updated":1791575911983,"result":"V, the root filesystem currently has 42 GB of free disk space.","error":null}]
hermesRun: {"http":200,"status":"completed","session_id":"voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9","last_event":"run.completed","output":"V, the root filesystem currently has 42 GB of free disk space."}
spoken: "On it. V, the root filesystem currently has42 gigabytes free."
```

It took one job and one try, and finished in 6.7 s.

"Cannot import" lines after the update started (19:54:23Z):

```
$ journalctl --user -u hermes-gateway.service --since "2026-10-09 19:54:23" -o cat | grep -ci "cannot import"
0
$ journalctl --user -u voice-frontend.service --since "2026-10-09 19:54:23" -o cat | grep -ci "cannot import"
0
$ sed -n '4024,$p' ~/.hermes/logs/update.log | grep -ci "cannot import"     # line 4024 = "=== hermes update started 2026-10-09T19:54:24 ==="
0
```

`~/.hermes/logs/errors.log` and `update.log` contain older "cannot import" lines. The newest `errors.log` entry follows an entry dated `2026-10-05 17:17:19`. The others are dated 2026-09-28 and 2026-10-08, or come from older update runs. None are after the update.

## 2e: No replay after a restart — PASS

`node scripts/live-e2e/fix2.mjs 2e`. A spoken long task, then `systemctl --user restart hermes-gateway.service` while the run was in flight. I stayed in the same call, while the app reconnected to Hermes on its own. Then I opened a second, new call to confirm the interruption is never read again.

```
2026-10-09T20:00:40.800Z said "Please start a background task: on this server, wait four minutes using the sleep command, then tell me it finished."
2026-10-09T20:00:41.803Z job abc57527-1566-4ac0-b8de-ec7a905a0d06 created (running)
2026-10-09T20:00:56.805Z job abc57527-… running as run_6209e561b2cd4fe18de8881cd2cd1483; restarting hermes-gateway.service
2026-10-09T20:01:30.351Z restart command returned
2026-10-09T20:01:30.352Z job state interrupted after 31.76s

=== 2e PASS settled interrupted in 31.76s; assistant turns mentioning it=1; later-call deliveries=0
SQL: SELECT j.id,j.state,j.run_id,j.updated,j.error,j.result,d.state AS delivery,d.session AS delivered_in,d.updated AS delivered_at FROM jobs j LEFT JOIN deliveries d ON d.job=j.id WHERE j.id=?
ARGS: ["abc57527-1566-4ac0-b8de-ec7a905a0d06"]
ROWS: [{"id":"abc57527-1566-4ac0-b8de-ec7a905a0d06","state":"interrupted","run_id":"run_6209e561b2cd4fe18de8881cd2cd1483","updated":1791576088565,
        "error":"Hermes restarted during this task, so it stopped part way. It was not run again.","result":null,
        "delivery":"injected","delivered_in":"live_EXB3UYyzC0njD87VAg8VU","delivered_at":1791576088719}]
hermesRun: 200 {"status":"interrupted","error":"Gateway shutdown interrupted the run.","last_event":"run.interrupted"}
assistantAfterRestart (call live_EXB3UYyzC0njD87VAg8VU):
  2026-10-09T20:01:29.822Z V, quick update: Hermes restarted during that task, so it stopped part way and it wasn't run again.
laterCallDeliveries (new call live_EXB4mL6Xte6JIkDfkP7LJ, 45 s): []
laterCallAssistant: (none)
```

The job showed as interrupted after 31.8 s, within the 60 s limit. Exactly one plain sentence was spoken, and the result is null. The new call had no delivery and no assistant speech.

An earlier 2e attempt at 19:59:13Z never got a call. `/api/live` returned `connection_error` before any session existed (audit: `connection.error {"reason":"connection_error"}`, `session:null`). This was the Azure side, after several calls in a row on the 10K TPM deployment. No job was created. The rerun one minute later is the result above.

## 2f: Quick answer during long work — PASS

`node scripts/live-e2e/fix2.mjs 2f`, with both requests spoken:

```
2026-10-09T19:40:58.669Z said "Please start a background task: on this server, wait three minutes using the sleep command, then tell me it finished."
2026-10-09T19:40:59.673Z job 326f00f8-d006-4de9-a838-71c849ca8b4d created (running)
2026-10-09T19:41:13.239Z said "Also, check how long this server has been up."
2026-10-09T19:41:14.240Z job 0f79cdfa-b68e-46d8-bd3e-6087a4884f44 created (running)
2026-10-09T19:41:24.261Z quick completed after 9.762s; long state then running

=== 2f PASS quick took 9.762s; long was running when quick completed; long finished 160.561s later
SQL: SELECT id,state,run_id,hermes_session,created,updated,substr(result,1,200) AS result FROM jobs WHERE id IN (?,?)
ARGS: ["326f00f8-d006-4de9-a838-71c849ca8b4d","0f79cdfa-b68e-46d8-bd3e-6087a4884f44"]
ROWS: {
 "jobs": [
  {"id":"0f79cdfa-b68e-46d8-bd3e-6087a4884f44","state":"completed","run_id":"run_2e984b7d194a4cebbd906aaa0b364e9b","hermes_session":"voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9-0f79cdfa","created":1791574874047,"updated":1791574883809,"result":"V, this server has been up for 16 days, 5 hours, and 48 minutes."},
  {"id":"326f00f8-d006-4de9-a838-71c849ca8b4d","state":"completed","run_id":"run_79bd97e3ecde41c2b3850ddfaae904bd","hermes_session":"voice-ccad5a2f-2433-4361-bfc8-bba14d7973e9","created":1791574859463,"updated":1791575044370,"result":"V, the three-minute wait finished successfully."}
 ],
 "longStateWhenQuickFinished": "running"
}
```

The long job ran 185 s, which is over 2 minutes. The quick job ran 9.8 s, under 30 s, and was delivered while the long job was `running`: deliveries `0f79cdfa… injected at 1791574896515`, `326f00f8… injected at 1791575044507`, both in session `live_EXAkPGsu97Gm8JcFJV4O4`.

An earlier attempt (19:39, FAIL) did not test the check. Speech recognition turned "sleep 180" into "sleep180", so Hermes failed that command in 8.5 s ("sleep180 was not found on this server"). The quick request (bitcoin price) took 53 s:

```
=== 2f FAIL quick took 53.266s; long was completed when quick completed; long finished -60.918s later
```

I reworded the long request ("wait three minutes using the sleep command") and used a faster quick request.

## 2g: Health tells the truth — PASS

`node scripts/live-e2e/fix2.mjs 2g` samples `GET /healthz` and Hermes `GET /health` side by side. It takes two samples, stops `hermes-gateway.service` for 30 s and samples every 5 s, starts the gateway, then samples every 3 s until Hermes is back.

```
2026-10-09T19:37:51.656Z stopping hermes-gateway.service for 30 s
2026-10-09T19:38:25.728Z started hermes-gateway.service
2026-10-09T19:37:51.621Z hermes: ok | healthz: ready [] | agree: true
2026-10-09T19:37:51.649Z hermes: ok | healthz: ready [] | agree: true
2026-10-09T19:37:55.431Z hermes: UND_ERR_SOCKET | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:00.649Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:05.658Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:10.668Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:15.676Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:20.685Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:25.728Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:28.735Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:31.741Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:34.748Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:37.754Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:40.761Z hermes: ECONNREFUSED | healthz: degraded ["hermes"] | agree: true
2026-10-09T19:38:43.767Z hermes: ok | healthz: ready [] | agree: true
2026-10-09T19:38:43.774Z hermes: ok | healthz: ready [] | agree: true
=== 2g PASS 16/16 samples agree; degraded samples naming hermes=12
```

An example of a degraded body:

```
"healthz": {"status":"degraded","down":["hermes"],"hermes":{"ok":false,"error":"Hermes is not answering (ECONNREFUSED)."}}
```

`/healthz` said `ready` only when Hermes said `ok`. The case where Hindsight is down is covered by the 2g code test.

## Observations (not part of Fix 2's checks)

- In the 2f call the voice model said "the server's been up twenty-one days…" at 19:41:24.9, before the result was delivered. The real result (16 days) was spoken at 19:41:37. It also repeated a line from the previous call ("The three-minute wait ended right away because the sleep command wasn't available"). The `deliveries` rows show the app pushed only this call's two jobs, so both came from the model's own guessing and history. Fix 4 (honest status) and the Fix 1 prompt rule cover this.
- `hermes update` printed advisories (standalone gateways, `hermes sessions optimize-storage`). I acted on none of them.
