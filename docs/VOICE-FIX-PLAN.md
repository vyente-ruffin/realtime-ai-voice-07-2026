# JARVIS Voice: Fix Plan and Definition of Done

Oct 9, 2026 · @Ruffin

Four fixes, done in order. A fix is done only when every check under it passes and the evidence is pasted under that check. These four problems were seen in V's own voice sessions from Sep 21 to Oct 9.

## Rules for whoever does the work

- **Change only our app.** The code lives in `~/homelab/realtime-ai-voice-memory` (`web/live.js`, `src/live/*.js`). Never edit Hermes or Hindsight source code. Configure them only with settings their docs name.
- **One fix at a time, in order.** Commit and push after each fix passes. Restart `voice-frontend.service` only when no job is running.
- **Evidence, not opinion.** Every check below is a command, a query, or a spoken test with a pass/fail line. Paste the output. A check without pasted output is not done.
- **Stuck?** Read the source listed under that fix first. If the sources don't settle it, stop and ask V. Don't invent a workaround.
- **Where the evidence lives.** The state database is `~/.local/state/jarvis-voice/state.sqlite`, with the tables `fragments` (what was said, with times), `jobs` and `deliveries`. Open it read-only. The health check is `curl -s 127.0.0.1:8787/healthz`.
- **What "a test session" means.** V or the tester opens the voice page, talks, and ends the call. Times come from the `fragments` table, not from memory.

## Fix 1: stop the unasked talking

The goal is that JARVIS never reads a result you didn't ask for, and stays quiet after "stop." Today the browser reads out any finished, unheard job as soon as there's a gap in the audio, however old the job is.

**What V saw.** On Oct 9 it opened a call by reading a result from Oct 5. On Oct 4, four seconds after V said "stop," it read out a result from Sep 24.

**Where it happens today**

- `web/live.js:455`: `deliver()` runs every 200 ms (line 1000). It picks any job whose delivery state is "available," with no age limit and no check that the job belongs to this call.
- `web/live.js:509`: the result is pushed with `session.commentary.append`, which tells the model to say it aloud.
- `src/live/server.js:75`: a job that was never heard defaults to "available" forever.
- `src/live/policy.js:71`: the speech rule "Announce a supplied final outcome once at a suitable pause."

**What to change**

1. **Old results.** Results from jobs started in an earlier call are never pushed automatically. When a call starts and such results exist, the app sends one spoken line, for example "Two things finished while you were away. Want them?" Each result is read only after V says yes. A job whose delivery is already "offered" or "injected" doesn't count.
2. **Results from this call.** Push at most one result per pause. A pause means V hasn't spoken for 2 s and the assistant isn't speaking.
3. **After V interrupts.** When V talks over the assistant, or says stop, quiet, or shut up, nothing is pushed until V has spoken a new request and the assistant has answered it.
4. **The old backlog.** Every job finished before the day this fix ships is marked as already offered. Nothing from before that date can ever be read out automatically.

**Done when all of these pass**

| # | Check | How to measure | Pass |
| --- | --- | --- | --- |
| 1a | No unasked old results | Finish a job, end the call, wait 5 minutes, start a new call and stay silent for 60 s. Query `deliveries` for the new call's session. | Zero rows for jobs from the earlier call. The transcript shows exactly one assistant line about waiting results. |
| 1b | Results on request | In that same call, say "yes, tell me." | The result is spoken. A `deliveries` row for that job appears with state `injected` after V's "yes" fragment. |
| 1c | Silence after stop | Start a call with two results from this call waiting. Say "stop" while the first is being read, then stay silent for 30 s. | No assistant fragment that starts more than 1 s after V's "stop" fragment, and no new `deliveries` row in that 30 s. Words already playing when V spoke may finish within that 1 s. |
| 1d | Back to normal after stop | Ask a new question after 1c. | The assistant answers it. Results resume only after that answer. |
| 1e | Old backlog closed | Count jobs finished before the ship date whose delivery is "available" or missing. | The count is 0. |
| 1f | The Oct 4 case cannot repeat | Across every test call, look for a `deliveries` row created less than 10 s after a user fragment that overlapped assistant speech. | Zero rows. |

**Sources if stuck**

- Microsoft Learn, [What is GPT-Live](https://learn.microsoft.com/azure/foundry/openai/concepts/gpt-live), section "Speech and task work run independently." Interrupting speech doesn't cancel work, and a finished job doesn't mean the user heard it. The app owns delivery.
- Microsoft Learn, [Use GPT-Live for real-time voice](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live), section "Add context during the conversation." `session.commentary.append` is spoken aloud and `session.thinking.append` is quiet context. Use thinking for the waiting count if you only want the model to know about results, not say them.

## Fix 2: make it the same JARVIS

The goal is that voice jobs run on V's main Hermes profile, with the same memories and tools as Telegram, and survive Hermes updates. Today our app starts its own private Hermes process on the `voice-live-preview` profile, which has automatic memory recall turned off. That process never restarts after a Hermes update.

**What V saw.** On Oct 4, a lookup failed with "internal error" because that private process was still running code from before the Oct 3 update. On Sep 22, a second question waited behind a slow first one, because the private process runs one job at a time.

**Where it happens today**

- `src/live/worker.js:1-40`: `VoiceWorker` starts a Hermes ACP child process and runs jobs through it one at a time.
- `src/live/server.js:46`: memory config defaults to the voice profile's Hindsight config.
- `src/live/server.js:177`: the health check reports "ready" even when no worker is running.

**What to change**

1. **Send jobs to the main Hermes.** Replace the ACP child in `worker.js` with calls to the Hermes API server that already runs inside `hermes-gateway.service` (main profile, `http://10.69.3.175:8642`). The key is `API_SERVER_KEY` in `~/.hermes/.env`.
   - Start a job with `POST /v1/runs`. Pass the job's request as `input`, the worker prompt from `policy.js:87` as `instructions`, and one `session_id` per voice conversation. Send the job id as the `Idempotency-Key`.
   - Follow it with `GET /v1/runs/{id}/events`. Cancel with `POST /v1/runs/{id}/stop`. Answer approvals with `POST /v1/runs/{id}/approval`.
   - Store the Hermes run id on the job.
2. **Run jobs side by side.** Drop the one-at-a-time queue. Hermes runs up to 10 at once and returns HTTP 429 beyond that. On a 429, tell V "I'm at capacity" instead of queueing quietly.
3. **Use the main memory.** Set `HINDSIGHT_CONFIG_PATH=/home/localadmin/.hermes/hindsight/config.json` in the `voice-frontend.service` drop-in.
4. **Honest health.** `/healthz` says "ready" only when Hermes `GET /health` and Hindsight both answer. Otherwise it names which one is down.
5. **Leave the old voice gateway running for now.** Stop `hermes-gateway-voice.service` only after two clean weeks. Keep the voice profiles for 30 days after that.

**Done when all of these pass**

| # | Check | How to measure | Pass |
| --- | --- | --- | --- |
| 2a | No private Hermes | Run `ps --ppid $(systemctl --user show -p MainPID --value voice-frontend.service) -o args` | No `hermes` or `acp` process listed. |
| 2b | Jobs are real Hermes runs | For each voice job in the test, call `GET /v1/runs/{run_id}` with the key. | Every job has a run id, and Hermes reports a matching status. |
| 2c | Same memory as Telegram | Tell JARVIS on Telegram a new fact with a unique word, such as "my test word is \<random word>." Wait 10 minutes. Then ask voice "what's my test word?" | Voice says the word. |
| 2d | Survives a Hermes update | Run `hermes update`, wait for `hermes-gateway.service` to come back, then give voice a task that needs a tool. | The task succeeds on the first try. The log has zero "cannot import" lines after the update. |
| 2e | No replay after a restart | Start a long voice task, run `systemctl --user restart hermes-gateway.service`, then reconnect. | Within 60 s the job shows as interrupted, and V hears one plain sentence saying so. It is never read later as a fresh result. |
| 2f | Quick answer during long work | Start a task that takes over 2 minutes, then ask for something that takes under 30 s. | The quick result arrives while the long job's state is still `running`. |
| 2g | Health tells the truth | Compare `/healthz` with Hermes `GET /health`, now and after stopping the gateway for 30 s. | `/healthz` says ready only when Hermes says ok. |

**Sources if stuck**

- Hermes docs, [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server): the sections "Runs API," "GET /health," "Long-term memory scoping," "Authentication" and "Configuration." A local copy is at `~/.hermes/hermes-agent/website/docs/user-guide/features/api-server.md`.
- Hermes docs, [Programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration): when to use the API server rather than ACP.
- Hindsight docs, [Hermes integration](https://hindsight.vectorize.io/sdks/integrations/hermes): the supported `auto_recall`, `recall_budget` and `bank_id` settings. Change these only through config, never in code.

## Fix 3: answer questions about V from memory, quickly

The goal is that questions about V are answered from his real memory, the same way any other request is. The answer has to be correct, conversational and back in a reasonable time. There are no canned or hard-coded answers. Since Fix 2, voice already looks things up through the main Hermes profile and its Hindsight memory. So this fix starts by measuring, and changes something only if a check fails.

**What V saw.** On Sep 22, "What do you know about me" took 81 seconds, because it waited in line behind other work on the old private Hermes. Fix 2 removed that line.

**What to change**

1. **Measure first.** Run the checks below on the current build.
2. **Fix only what fails, and only with documented settings or speech rules.** Examples are the Hindsight `recall_budget`, how mental models refresh, or when the voice hands off. Never write facts about V into code or prompts.

**Done when all of these pass**

| # | Check | How to measure | Pass |
| --- | --- | --- | --- |
| 3a | Correct from memory | In one call, ask: "What's my name?", "What do you know about me?", "Who is Teresa?", "What am I working on right now?" Compare each spoken answer with a Hindsight recall for the same question on bank `hermes`. | Every fact spoken is in V's memory. Nothing is made up. |
| 3b | Fresh memory, not canned | Tell the main profile a new fact with a unique word using `hermes -z`, wait 10 minutes, then ask voice for it. | Voice says the new word, which proves the answer came from memory. |
| 3c | Reasonable time | For each question in 3a and 3b, time from the end of V's question to the first words of the actual answer, using `fragments` timestamps. A "one sec" acknowledgement doesn't count. | Each answer starts within 10 seconds. |
| 3d | Conversational | Follow up with "And what does she do?" right after "Who is Teresa?" | It answers in context from memory, without asking who "she" is. |
| 3e | Nothing hard-coded | Search the diff for this fix for any of V's personal facts. | Zero hits. |

**Sources if stuck**

- Hindsight docs, [Hermes integration](https://hindsight.vectorize.io/sdks/integrations/hermes): the recall settings `recall_budget`, `auto_recall` and `recall_types`.
- Hindsight docs, [Mental models](https://hindsight.vectorize.io/developer/mental-models): the memory summaries our app already loads, and how they refresh.
- Microsoft Learn, [Delegate work in GPT-Live](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-delegation): when the voice model hands a question to the backend.

## Fix 4: give honest status

The goal is that "how's it going" always gets the job's real state: what it is, how long it has run, what it's doing now, or why it failed. Today the voice model gets only a list of job ids and one-word states. So it can't say which task is which, or what's happening.

**What V saw.** On Oct 5, V asked "any updates" and JARVIS said "nothing solid yet" and went quiet. On Oct 4, a failure was described as "an internal glitch," and then blamed on "the system."

**Where it happens today**

- `web/live.js:132`: `quietJobs()` sends the model the 8 newest jobs as id and state only. There's no task name, no age, no progress and no failure reason.
- `src/live/policy.js:71`: "App job states are authoritative," but the states it gets are too thin to describe.

**What to change** (needs Fix 2, because progress comes from Hermes run events)

1. **Richer quiet context.** For each running or recently finished job in this conversation, send a short task name, the state, the minutes elapsed, the latest progress step and, for a failure, a one-line reason in plain words.
   - The task name comes from V's request.
   - The latest progress step comes from the newest `tool.started` or `message.interim` event in Hermes.
   - Send it again whenever any of these change.
2. **Plain failure reasons.** Translate failures into plain words: Hermes restarted, Hermes was busy, you cancelled it, it needs your approval, or the tool failed and why. Never pass raw error text such as "Internal error" to the model.
3. **Status speech rule.** When asked about status, name the task and say its state from this context. When there's no running job, say so. Never answer status from memory or guesswork.

**Done when all of these pass**

| # | Check | How to measure | Pass |
| --- | --- | --- | --- |
| 4a | Status matches reality | Start a task that runs over 2 minutes. Ask "how's it going?" at about 30 s and again at about 90 s. | Both answers name the task, and the state spoken matches the `jobs` row at that moment. |
| 4b | Says what it's doing | After the job's first tool step, ask "what are you doing on that?" | The answer describes the newest Hermes progress event for that run. |
| 4c | Failures in plain words | Cancel a running job with `POST /v1/runs/{id}/stop`, and separately restart `hermes-gateway.service` during a job. Ask about each. | The two answers say "you cancelled it" and "Hermes restarted" respectively. Neither says "internal error" or "glitch." |
| 4d | Correct when nothing is running | With no running jobs, ask "is anything running?" | The answer is no, and matches `jobs` having zero running rows. |
| 4e | Banned vague phrases | Search all assistant fragments from the test calls. | Zero hits for "nothing solid yet," "internal glitch" or "the system ran into." |

**Sources if stuck**

- Hermes docs, [API Server: Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server): the sections "GET /v1/runs/{run\_id}" and "GET /v1/runs/{run\_id}/events" cover status polling and the `tool.started`, `message.interim` and `run.completed` events. "POST /v1/runs/{run\_id}/stop" shows a stopped run settling as `cancelled`.
- Microsoft Learn, [What is GPT-Live](https://learn.microsoft.com/azure/foundry/openai/concepts/gpt-live), section "Speech and task work run independently." Check spoken confirmations against the app's own state.
- Microsoft Learn, [Use GPT-Live for real-time voice](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live), section "Add context during the conversation." `session.thinking.append` is quiet context capped at 500 tokens per event, so keep each job's line short.

## Round 2 (Oct 14): from V's Oct 13 evening calls

Same rules as above. Also: the live service already runs Fixes 1 to 4, so every Fix 1 to 4 check must still pass after each new fix. Test calls use their own test conversation and `scripts/live-e2e/cleanup.mjs`, never V's conversation `ccad5a2f-2433-4361-bfc8-bba14d7973e9`.

**Important limit.** GPT-Live has no turn-taking setting. The session object is strict and accepts only `model`, `instructions`, `audio.output.voice` and `delegation`. Microsoft says the live model "decides when to respond" and you steer it "with a short set of session instructions." So Fix 5 is an instruction change, proven by live tests. Keep the instructions short.

## Fix 5: let V finish talking

The goal is that JARVIS doesn't jump in when V pauses mid-sentence. On Oct 13 it said "I'm on it" or "Yeah" about ten times while V was still talking ("Do we have logging" / "I'm on it" / "100").

**What to change.** Change the speech instructions in `src/live/policy.js` so the model waits when V's words sound unfinished (a trailing "uh", "and", "so", or a half sentence). It stays silent until V finishes, with no "I'm on it" or "Yeah" acknowledgements during a pause. Interrupting the assistant must still stop it at once (Fix 1).

**Done when all of these pass** (each run is a live call with a spoken WAV via `scripts/live-e2e/`)

| # | Check | How to measure | Pass |
| --- | --- | --- | --- |
| 5a | Waits through a mid-sentence pause | WAV: "So can you check... uh..." then 1.5 s of silence, then "what time it is in Tokyo." Run 5 times. | In 5 of 5 runs, no assistant fragment starts between the end of "uh" and the start of "what time." |
| 5b | Answers once, after V finishes | Same runs. | Exactly one answer, which starts after the last user fragment. At most one job per run. |
| 5c | Still answers promptly | Same runs. | The first assistant fragment after V finishes starts within 3 s in at least 4 of 5 runs. |
| 5d | Interruption still works | Rerun the Fix 1 check 1c. | It passes. |

**Sources if stuck**

- Microsoft Learn, [What is GPT-Live](https://learn.microsoft.com/azure/foundry/openai/concepts/gpt-live), section "How GPT-Live works." The live model "decides when to respond," and you steer it with session instructions about conversational style.
- Microsoft Learn, [Use GPT-Live for real-time voice](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live), section "Session configuration." The session object rejects unknown fields, so there is no turn-detection setting to add. `session.instructions.append` adds trusted instructions mid-call.

## Fix 6: never claim something it didn't do

The goal is that JARVIS says "saved," "started," "done" or "I've told Claude Code" only when the app's records show it happened. On Oct 13 it said "Got it, I've saved that preference" about a preference V never stated. The job result it was reading said nothing about a preference.

**What to change**

1. **Speech instructions.** Claims about memory saves, started jobs and finished jobs must come from app-confirmed state in this call. That state is the jobs list and memory-save confirmations the app already sends as quiet context. Never infer a preference V didn't state.
2. **Confirmed saves.** If the app doesn't already tell the model when a memory save finishes, add a short quiet `session.thinking.append` when it completes.

**Done when all of these pass**

| # | Check | How to measure | Pass |
| --- | --- | --- | --- |
| 6a | No made-up saves | 5 test calls, each asking 3 questions that need a job (for example, "is logging enabled on the voice app?"). Search the assistant fragments. | Zero matches for `saved\|noted\|I'll remember\|preference` in any call. |
| 6b | Real saves are confirmed honestly | 3 test calls: "Remember that my test color is <random word>." | It says "saved" only after the save completes (fragment time later than the memory-save completion time in the app's records), or it says it's saving. A recall afterward finds the word. `cleanup.mjs` invalidates it. |
| 6c | No made-up job claims | In the 6a calls, list every assistant fragment that says a job was started, handed off or done. | Each one has a matching `jobs` row in that call, created before the fragment. |

**Sources if stuck**

- Microsoft Learn, [What is GPT-Live](https://learn.microsoft.com/azure/foundry/openai/concepts/gpt-live), section "Speech and task work run independently." Verify spoken confirmations against your application's authoritative state.
- Microsoft Learn, [Delegate work in GPT-Live](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-delegation). The application keeps the authoritative task state, and an acknowledgment doesn't prove an action succeeded.

## Fix 7: handle a dropped call cleanly

The goal is that after the connection drops and comes back, JARVIS doesn't resume a half-finished sentence. On Oct 13 the call dropped (peer disconnected) mid-answer and reconnected 3 s later. JARVIS's first words on the new call were the tail of the old answer ("upgrades. You decided to hold off…"). It sounded random, and JARVIS then "apologized" for it.

**What to change**

1. **Reconnect history.** When a new session starts with earlier conversation as `input` history, an assistant turn that was cut off must be marked as cut off, or left out. The model must not continue it.
2. **Silent until V speaks.** A reconnected call follows the Fix 1 silent-connect rule. If a result from before the drop was cut off mid-speech, it stays available, and the app offers it once in plain words: "We got cut off. Want me to finish what I was saying?" That one line is the only allowed unprompted speech.

**Done when all of these pass**

| # | Check | How to measure | Pass |
| --- | --- | --- | --- |
| 7a | No resumed fragment | Test call: ask a question that gets a long answer, and drop the connection (close the peer connection) 2 s into the answer. Let the app reconnect. Run 3 times. | In 3 of 3 runs, the first assistant fragment of the new session is either nothing (silence until the user speaks) or the single "we got cut off" offer. It never continues the old sentence. |
| 7b | Can get the answer back | After 7a, say "yes, finish." | The full answer is spoken, matching the job result. |
| 7c | Fix 1 still holds | Rerun 1a and 1c. | Both pass. |

**Sources if stuck**

- Microsoft Learn, [What is GPT-Live](https://learn.microsoft.com/azure/foundry/openai/concepts/gpt-live), sections "Context management in long conversations" (keep task state in your application and supply it when needed) and "Speech and task work run independently" (a completed response doesn't mean the user heard it).
- Microsoft Learn, [Use GPT-Live via WebRTC](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-webrtc) for how the session and history are created.

## Sources

- [What is GPT-Live](https://learn.microsoft.com/azure/foundry/openai/concepts/gpt-live) (Microsoft Learn)
- [Use GPT-Live for real-time voice](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live) (Microsoft Learn)
- [Use GPT-Live via WebRTC](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-webrtc) (Microsoft Learn): confirms our setup, where the browser connects through our server, is the documented pattern.
- [Delegate work in GPT-Live](https://learn.microsoft.com/azure/foundry/openai/how-to/gpt-live-delegation) (Microsoft Learn)
- [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Hindsight mental models](https://hindsight.vectorize.io/developer/mental-models)
- [Hindsight best practices](https://hindsight.vectorize.io/best-practices#mental-models)
- [Hindsight Hermes integration](https://hindsight.vectorize.io/sdks/integrations/hermes)
