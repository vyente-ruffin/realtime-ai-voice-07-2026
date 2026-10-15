# Logging covers the whole flow (send audit): evidence

Oct 15, 2026 · build `f50d6f6de23a7dba` (voice-frontend.service restarted 23:36:13 UTC after a state backup `state.sqlite.20261015T233613Z`, with 0 queued/running/awaiting_permission jobs).

## What changed

- **Browser (`web/live.js`, `src/live/telemetry.js`).** Every `append()` to GPT-Live (thinking, commentary, instructions) records a `model.send` row: event type, `event_id`, `delegation_id`, purpose label (`memory`, `clock`, `job-status`, `result`, `consent`, `cut-off`, `save-confirmation`, `instructions`), content length and send time. Every `*.appended` ack records `model.ack` (ack time and ms since send), and every provider `error` naming an event id records `model.rejected`. Ack rows carry the call of the send they answer. The schema rejects any content field, so text can never be stored. App decisions (`delegation.received`, `delivery.stop`, `delivery.consent`, `result.waiting_offered`, cut-off offers) now carry `callId` and the delegation id.
- **Server (`src/live/server.js`, `src/live/worker.js`).** New audit rows: `job.queued` (job, delegation, session), `job.state` on every state change and `job.run_started` (adding the Hermes run id and Hermes session), `delivery.offered`, `delivery.injected`, `delivery.released` (job, session, offer event id). The result send's `event_id` is the offer id plus `_0`, so a result is traced from Hermes run to model send to ack to playback.
- **Trace (`scripts/live-e2e/trace.mjs <callId>`).** Prints the call's flow in time order from the logs alone (audit rows, transcript fragments, jobs, deliveries, and `~/.hermes/logs/agent.log` lines for each run id and Hermes session, with `msg='…'` redacted). It lists the required steps and checks for gaps: a send without an ack, an ack without a send, a delegation without a job, a job without its run id or agent.log line, an offer without a result send or injected/released row.
- **Two fixes found while finishing the test.** Saying "stop" ends the "result being read" mark, so a later drop doesn't offer the stopped result back. A drop clears the earlier yes for that job, so the cut-off result is offered again ("We got cut off…") and not re-read without asking.

Best practice met (MS Learn, [Best practices for monitoring and diagnostics: Instrument an application](https://learn.microsoft.com/azure/architecture/best-practices/monitoring#instrument-an-application), fetched with the Learn MCP `microsoft_docs_search`): "Use structured logging" (each row is a typed JSON record validated by schema); "identify the source and provide context and timing information as each log record is written" (each trace line names its source, browser/server/transcript/hermes, and carries its time); "Use the same time zone and format for all timestamps" and "record all dates and times by using UTC" (trace prints ISO 8601 UTC; agent.log times are converted from UTC); "associate each request with a unique activity ID propagated through the system" (callId → session → delegation → job → Hermes run id → offer/event id). Also [Architecture strategies for designing a monitoring system](https://learn.microsoft.com/azure/well-architected/operational-excellence/observability#emit-telemetry-from-workload-components): "Scrub sensitive system or user information before logging" (lengths only, never content) and "ensure failures in telemetry do not cascade into application failures" (`auditOrWarn` and try/catch around the worker's audit write).

## L1: one live call, whole flow traced from the logs: PASS

Command: `node scripts/live-e2e/logging.mjs` (run 2, `logs/live-e2e/logging-run2.log`). The call connects, asks "How much free disk space is left on this server?" (needs a Hermes job), hears the result (waits for `result.playback_observed` plus 3 s of quiet), says "Stop.", asks "What's the capital of France?", hears "Paris." and hangs up. Then the trace is printed by itself:

Command: `node scripts/live-e2e/trace.mjs 6e4b3fda-4550-4471-961e-47dc6610157c`

```
call 6e4b3fda-4550-4471-961e-47dc6610157c  conversation b04f4366-ccca-40af-9383-a514d5048d28  sessions live_EZPIQWDqzA7x3v00HGF1c  (call.stats samples: 8)
2026-10-15T23:37:06.392Z  browser    connection.started           [call=6e4b3fda-4550-4471-961e-47dc6610157c]
2026-10-15T23:37:06.444Z  browser    connection.microphone      microphone=live  [call=6e4b3fda-4550-4471-961e-47dc6610157c]
2026-10-15T23:37:06.459Z  browser    connection.audio_context   audioContext=running  [call=6e4b3fda-4550-4471-961e-47dc6610157c]
2026-10-15T23:37:07.461Z  server     session.started            connectionMs=862 providerRequestId=b4257fba-0ab9-46ed-888b-1e46bb229135  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:07.470Z  browser    connection.playback        playback=track_received  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:07.482Z  browser    connection.state           connection=connecting  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:07.492Z  browser    connection.playback        playback=playing  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:07.654Z  browser    connection.state           connection=connected  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:07.776Z  browser    connection.open              [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:07.959Z  browser    connection.session.started   [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:12.197Z  browser    model.send                 session.thinking.append purpose=job-status length=134  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=dcac0c0f-77e9-466e-a400-72ff616bc9e5_0]
2026-10-15T23:37:12.275Z  browser    model.ack                  session.thinking.appended purpose=job-status ackMs=78  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=dcac0c0f-77e9-466e-a400-72ff616bc9e5_0]
2026-10-15T23:37:13.178Z  browser    model.send                 session.thinking.append purpose=clock length=349  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=2e03e8e6-e574-4441-ac01-c2382b4f520b_0]
2026-10-15T23:37:13.262Z  browser    model.ack                  session.thinking.appended purpose=clock ackMs=84  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=2e03e8e6-e574-4441-ac01-c2382b4f520b_0]
2026-10-15T23:37:13.279Z  transcript turn.user                  "How much free disk space is left on this server"  [session=live_EZPIQWDqzA7x3v00HGF1c audioMs=5000-7400]
2026-10-15T23:37:15.416Z  browser    delegation.received          [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c delegation=item_EZPIZoOKs2yIWMSCTbNZZ]
2026-10-15T23:37:15.421Z  server     job.queued                 state=queued  [session=live_EZPIQWDqzA7x3v00HGF1c delegation=item_EZPIZoOKs2yIWMSCTbNZZ job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11]
2026-10-15T23:37:15.424Z  server     job.state                  state=running  [session=live_EZPIQWDqzA7x3v00HGF1c delegation=item_EZPIZoOKs2yIWMSCTbNZZ job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11]
2026-10-15T23:37:15.426Z  browser    model.send                 session.thinking.append purpose=job-status length=231  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=54be9da2-7418-4c07-a017-52ef45154c65_0]
2026-10-15T23:37:15.428Z  browser    model.send                 session.thinking.append purpose=job-status length=222  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=5a4af1c9-7932-44eb-a34b-0fcaede744f0_0]
2026-10-15T23:37:15.512Z  browser    model.ack                  session.thinking.appended purpose=job-status ackMs=86  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=54be9da2-7418-4c07-a017-52ef45154c65_0]
2026-10-15T23:37:15.540Z  browser    model.ack                  session.thinking.appended purpose=job-status ackMs=112  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=5a4af1c9-7932-44eb-a34b-0fcaede744f0_0]
2026-10-15T23:37:16.083Z  transcript turn.assistant             "I’ll check the server’s free disk space."  [session=live_EZPIQWDqzA7x3v00HGF1c audioMs=7400-8600]
2026-10-15T23:37:17.786Z  server     job.run_started            state=running run=run_53a5fb71f28b4ded8c415d5ed48999b4 hermesSession=voice-b04f4366-ccca-40af-9383-a514d5048d28-live_EZPIQWDqzA7x3v00HGF1c  [session=live_EZPIQWDqzA7x3v00HGF1c delegation=item_EZPIZoOKs2yIWMSCTbNZZ job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 run=run_53a5fb71f28b4ded8c415d5ed48999b4]
2026-10-15T23:37:17.820Z  hermes     hermes.log                 agent.turn_context: conversation turn: session=voice-b04f4366-ccca-40af-9383-a514d5048d28-live_EZPIQWDqzA7x3v00HGF1c model=gpt-6.1-sol provider=copilot platform=api_server history=0 msg=<redacted>  [run=run_53a5fb71f28b4ded8c415d5ed48999b4 job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 matched=hermes_session]
2026-10-15T23:37:20.626Z  hermes     hermes.log                 agent.conversation_loop: API call #1: model=gpt-6.1-sol provider=copilot in=20743 out=25 total=20768 latency=2.6s write=20740 id=J4RqPL9JvxvLQ7VOaH9Awt+DhD5WncTBZbjPXd+0Y1VaTRRsttgiDi9Saj3sEKZg1s31QB1RlXwJkIGP2LDD3eWIfVW  [run=run_53a5fb71f28b4ded8c415d5ed48999b4 job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 matched=hermes_session]
2026-10-15T23:37:20.653Z  browser    model.send                 session.thinking.append purpose=job-status length=264  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=a9ef4ba8-74a2-4da4-a4fc-4db66a36b37d_0]
2026-10-15T23:37:20.726Z  hermes     hermes.log                 agent.tool_executor: tool terminal completed (0.08s, 172 chars)  [run=run_53a5fb71f28b4ded8c415d5ed48999b4 job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 matched=hermes_session]
2026-10-15T23:37:20.733Z  browser    model.ack                  session.thinking.appended purpose=job-status ackMs=80  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=a9ef4ba8-74a2-4da4-a4fc-4db66a36b37d_0]
2026-10-15T23:37:23.092Z  hermes     hermes.log                 agent.conversation_loop: API call #2: model=gpt-6.1-sol provider=copilot in=20838 out=25 total=20863 latency=2.3s cache=20740/20838 (100%) write=95 id=HEjAtWncOs746N/73C+J+iJaZXVDJfxHuBaaek0Xd7034aQxutlwf6Z9qx+w8DKJJdt0b  [run=run_53a5fb71f28b4ded8c415d5ed48999b4 job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 matched=hermes_session]
2026-10-15T23:37:23.119Z  hermes     hermes.log                 agent.conversation_loop: Turn ended: reason=text_response(finish_reason=stop) model=gpt-6.1-sol api_calls=2/150 budget=2/150 tool_turns=1 last_msg_role=assistant response_len=58 session=voice-b04f4366-ccca-40af-9383-a514  [run=run_53a5fb71f28b4ded8c415d5ed48999b4 job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 matched=hermes_session]
2026-10-15T23:37:23.144Z  hermes     hermes.log                 aiohttp.access: 10.69.3.175 [15/Oct/2026:23:37:17 +0000] "GET /v1/runs/run_53a5fb71f28b4ded8c415d5ed48999b4/events?last_seq=-1 HTTP/1.1" 200 4801 "-" "node"  [run=run_53a5fb71f28b4ded8c415d5ed48999b4 job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 matched=run_id]
2026-10-15T23:37:23.146Z  server     job.state                  state=completed run=run_53a5fb71f28b4ded8c415d5ed48999b4 hermesSession=voice-b04f4366-ccca-40af-9383-a514d5048d28-live_EZPIQWDqzA7x3v00HGF1c  [session=live_EZPIQWDqzA7x3v00HGF1c delegation=item_EZPIZoOKs2yIWMSCTbNZZ job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 run=run_53a5fb71f28b4ded8c415d5ed48999b4]
2026-10-15T23:37:23.151Z  browser    model.send                 session.thinking.append purpose=job-status length=242  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=a7912385-582c-48a5-9241-4a3c6ff7b664_0]
2026-10-15T23:37:23.227Z  browser    model.ack                  session.thinking.appended purpose=job-status ackMs=75  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=a7912385-582c-48a5-9241-4a3c6ff7b664_0]
2026-10-15T23:37:23.281Z  server     delivery.offered             [session=live_EZPIQWDqzA7x3v00HGF1c job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 event=result_7386b15b-1a7f-417c-af8f-24aea1312aa1]
2026-10-15T23:37:23.285Z  browser    model.send                 session.commentary.append purpose=result length=145  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c delegation=item_EZPIZoOKs2yIWMSCTbNZZ event=result_7386b15b-1a7f-417c-af8f-24aea1312aa1_0]
2026-10-15T23:37:23.364Z  browser    model.ack                  session.commentary.appended purpose=result ackMs=78  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c delegation=item_EZPIZoOKs2yIWMSCTbNZZ event=result_7386b15b-1a7f-417c-af8f-24aea1312aa1_0]
2026-10-15T23:37:23.368Z  server     delivery.injected            [session=live_EZPIQWDqzA7x3v00HGF1c job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 event=result_7386b15b-1a7f-417c-af8f-24aea1312aa1]
2026-10-15T23:37:24.479Z  transcript turn.assistant             "V, this server has 7.4 gigabytes free; its root disk is 97 percent full."  [session=live_EZPIQWDqzA7x3v00HGF1c audioMs=17000-21600]
2026-10-15T23:37:29.490Z  server     result.playback_observed     [session=live_EZPIQWDqzA7x3v00HGF1c job=0cbb7f5b-c736-4e75-b3c2-14a1bb252c11 event=result_7386b15b-1a7f-417c-af8f-24aea1312aa1]
2026-10-15T23:37:33.327Z  browser    model.send                 session.instructions.append purpose=instructions length=140  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=80e407fd-ec92-4627-acb1-04953c9f23e7_0]
2026-10-15T23:37:33.334Z  browser    delivery.stop                [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:33.412Z  browser    model.ack                  session.instructions.appended purpose=instructions ackMs=85  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c event=80e407fd-ec92-4627-acb1-04953c9f23e7_0]
2026-10-15T23:37:33.580Z  transcript turn.user                  "Stop"  [session=live_EZPIQWDqzA7x3v00HGF1c audioMs=26600-26800]
2026-10-15T23:37:40.586Z  transcript turn.user                  "What's the capital of France"  [session=live_EZPIQWDqzA7x3v00HGF1c audioMs=33200-34400]
2026-10-15T23:37:42.680Z  transcript turn.assistant             "Paris."  [session=live_EZPIQWDqzA7x3v00HGF1c audioMs=35200-35400]
2026-10-15T23:37:46.813Z  browser    connection.close.requested   [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:47.364Z  browser    connection.session.closed    [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:47.365Z  browser    connection.ending          reason=user_end  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]
2026-10-15T23:37:47.373Z  browser    call.ended                 reason=user_end  [call=6e4b3fda-4550-4471-961e-47dc6610157c session=live_EZPIQWDqzA7x3v00HGF1c]

STEPS {"connection started":1,"microphone live":1,"session started":1,"user turn":3,"assistant turn":3,"model send":8,"model ack":8,"delegation received":1,"job queued":1,"hermes run started":1,"hermes agent.log line":1,"job completed":1,"result offered":1,"result sent to model":1,"result injected":1,"playback":2,"result playback observed":1,"stop":1,"call ended":1}
MISSING []
GAPS []
TRACE PASS
exit=0
```

Wire vs. logs (the harness records the type and id of every data-channel event each way, no content). Every append the page sent and every ack it received has its own audit row:

```
[cleanup] {"run":"logging-mva6hnd5","testConversations":1,"hermesSessions":["voice-b04f4366-ccca-40af-9383-a514d5048d28-live_EZPIQWDqzA7x3v00HGF1c"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":1,"bySource":{"hermes-session":1},"invalidated":1,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-b04f4366-ccca-40af-9383-a514d5048d28-live_EZPIQWDqzA7x3v00HGF1c":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-curren
[isolation] owner conversation new fragments: 0
WIRE appends out=8 acks in=8 delegations in=1; audit model.send=8 model.ack=8
WIRE WITHOUT AUDIT ROW []
LOGGING PASS callId=6e4b3fda-4550-4471-961e-47dc6610157c
```

Result: no step missing (`MISSING []`), no gap (`GAPS []`), 8/8 sends and 8/8 acks on the wire have rows. **PASS.**

Run 1 (`logs/live-e2e/logging-run1.log`) also printed `TRACE PASS` and `WIRE WITHOUT AUDIT ROW []`, but the script said "stop" while the result was still being read and hung up before "Paris": the script's waits were fixed and run 2 is the one that counts.

## L2: a test proves each send path records a row: PASS

Command: `node --test --test-name-pattern="send audit" tests/live/send-audit.test.mjs tests/live/hermes-runs.test.mjs`

```
✔ send audit: each job state change leaves an audit row tying delegation, job and Hermes run id, without the request or result (53.026289ms)
✔ send audit: the schema accepts send/ack rows and rejects content text or unknown purposes (1.619445ms)
✔ send audit: every send path records a row with its purpose, length, ids and call; every ack records its time (8904.720188ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

The browser test drives the real page, server and SQLite (only the WebRTC peer is simulated) through every send path: job-status, consent, memory, clock, result, save-confirmation, instructions (stop) and cut-off after a drop. It asserts one `model.send` row per append on the channel with the same event type, event id, delegation id and content length; one `model.ack` per ack with ack time ≥ send time; a `model.rejected` row for a provider error; the delivery rows (`delivery.offered` → `delivery.injected` with the same offer event id as the result send); and `callId`, session and time on the app-decision rows. The worker test asserts `job.state`/`job.run_started` rows with job, delegation, session, run id and Hermes session. Full suite after the last change: `npm run -s test:live` → `ℹ tests 156  ℹ pass 156  ℹ fail 0`.

## L3: no memory text in the audit rows: PASS

Command: `node scripts/live-e2e/audit-privacy.mjs 1792107300000` (searches every audit payload since the build went live for each sentence ≥ 20 chars of the 3 prepared memory sections and of each job result; also fails if any `model.*` row has a content/text/result/instructions field):

```
{"since":1792107300000,"auditRows":91,"modelRows":32,"memorySentences":55,"resultTexts":2,"hits":0,"contentFieldsInModelRows":0}
exit=0
```

And a direct search for the spoken result text:

```
$ node -e '…readOnly…' "SELECT COUNT(*) n FROM audit WHERE at>=1792107300000 AND (payload LIKE '%gigabytes%' OR payload LIKE '%97 percent%')"
{"n":0}
```

Both tests also plant `PRIVATE_*` sentinels in the request, result, memory, save and error text and assert `SELECT COUNT(*) FROM audit WHERE payload LIKE '%PRIVATE_%'` is 0. **PASS.**

## Isolation

Both runs used their own test conversation and ran `cleanup.mjs` (`[isolation] owner conversation new fragments: 0` above). Direct check:

```
$ node -e '…readOnly…' "SELECT COUNT(*) n FROM fragments WHERE conversation='ccad5a2f-2433-4361-bfc8-bba14d7973e9' AND at>=1792107300000"
{"n":0}
```

## Limits

- Transcript turns come from `fragments` (the call's own words), which is how the plan defines "what was said"; they are not in the audit table by design, because they can contain personal text.
- `call.stats` samples (every 5 s) are counted in the trace header, not listed one by one.
- Playback evidence is the browser's output level, not proof a person heard it.
