# Evidence: 20 more test conversations (Phase A baseline)

Oct 17, 2026. Build `15d58281245485b0` (HEAD `8c1790a` of `claude/voice-fixes`, the live service).
Each run is one live call through headless Chrome with spoken WAVs, its own test conversation, and
`cleanup.mjs` after it (V's conversation: `owner+0` in every run). Every check is measured from
`~/.local/state/jarvis-voice/state.sqlite` by `scripts/live-e2e/convo-judge.mjs`, unchanged.

Command: `node scripts/live-e2e/convo.mjs 20` (one call at a time, 45 s apart).
Results file: `logs/live-e2e/convo-1792202491304.json` (local, git-ignored). Full log:
`logs/live-e2e/phaseA-convo20.log`.

**Result: 18 of 20 pass every check. 3 failed checks in 20 runs. 41 oddities in 20 runs.**

## Oddities: how they are counted

`scripts/live-e2e/convo-oddities.mjs` (new, read-only; fixed from here on, like the judge) scores
what the judge lets pass. It reads only the saved results file and the job's creation time from
state.sqlite. One count per item:

| kind | rule |
| --- | --- |
| `missingWords` | a word of a spoken utterance (fillers "uh" aside) is not in the user transcript between that utterance's start and the next one's |
| `noAnswer` / `slowAnswer` | no assistant fragment after "how's it going", the Tokyo question, the France question or the last question, or the first one more than 3 s after the utterance ends |
| `greetingStatus` | the reply to "Hey Jarvis, how's it going?" talks about tasks ("running", "task", "nothing's going on", "quiet", "idle") |
| `longAnswer` | greeting over 30 words; Tokyo answer over 1 sentence or 15 words; France answer over 1 sentence; result read over 35 words |
| `recapMissesLatest` | "What were we just talking about?" is answered without the disk-space result that was read just before (the latest topic) |

Command: `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792202491304.json`. Raw output:

```
1 PASS oddities=1 [recapMissesLatest] you had asked what time it is in tokyo, and then, while that was running, what the capital of france is.
2 PASS oddities=1 [missingWords] p2: missing right now
3 PASS oddities=3 [missingWords] p2: missing now | [greetingStatus] Nothing’s running right now. | [recapMissesLatest] we were talking about the current time in tokyo and the capital of france.
4 PASS oddities=3 [missingWords] p2: missing now | [missingWords] last: missing were just | [recapMissesLatest] you were asking what time it is in tokyo, and then you asked for the capital of france.
5 PASS oddities=1 [recapMissesLatest] you asked me for the current time in tokyo and the capital of france.
6 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] the current time in tokyo, and that paris is the capital of france.
7 PASS oddities=1 [missingWords] p2: missing now
8 PASS oddities=0 
9 PASS oddities=1 [missingWords] p2: missing now
10 PASS oddities=1 [missingWords] p2: missing now
11 PASS oddities=2 [missingWords] p2: missing now | [greetingStatus] Good. Nothing's running.
12 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] we weren't on a specific topic, you just said stop.
13 FAIL oddities=4 [missingWords] p2: missing now | [missingWords] france: missing while that's running what's the capital of | [missingWords] last: missing okay thanks what | [recapMissesLatest] the current time in tokyo.
14 FAIL oddities=3 [missingWords] france: missing while running what's the capital of france | [slowAnswer] france: 6319 ms | [recapMissesLatest] we were talking about the current time in tokyo.
15 PASS oddities=2 [greetingStatus] Nothing’s running right now. | [recapMissesLatest] you'd just asked what time it is in tokyo, and then asked, while that's running, what's the capital of france?
16 PASS oddities=3 [missingWords] p2: missing now | [greetingStatus] No task is running right now. So, nothing is in progress. | [recapMissesLatest] you'd asked for the current time in tokyo, and then asked about the capital of france.
17 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] you'd asked what time it is in tokyo, and then asked for the capital of france.
18 PASS oddities=3 [missingWords] p2: missing now | [greetingStatus] Nothing’s running right now. | [recapMissesLatest] you asked how to read a file's contents on this server, and i said we'd get the file contents. you then said stop, so i held off.
19 PASS oddities=4 [missingWords] p2: missing now | [missingWords] last: missing okay thanks what were | [greetingStatus] Good — quiet right now. No task is running at the moment. | [recapMissesLatest] you'd asked what time it is in tokyo and then the capital of france.
20 PASS oddities=2 [missingWords] p2: missing right now | [greetingStatus] Good, nothing's running right now.
ODDITIES 41 in 20 runs {"recapMissesLatest":13,"missingWords":20,"greetingStatus":7,"slowAnswer":1}
```

## Table

| run | result | silentOnConnect | silentInPause | hiNoTime | tokyoTime | franceParis | resultOnceEnglish | silentAfterStop | afterStopAnswered | notes (oddities, and what the voice said where it matters) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 1 oddities. recapMissesLatest: you had asked what time it is in tokyo, and then, while that was running, what the capital of france is.; tokyo: "It's 11:01 a.m. in Tokyo." |
| 2 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 1 oddities. missingWords: p2: missing right now; tokyo: "In Tokyo, it’s Saturday, October 17, at 11:03 in the morning." |
| 3 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 3 oddities. missingWords: p2: missing now; greetingStatus: Nothing’s running right now.; recapMissesLatest: we were talking about the current time in tokyo and the capital of france.; tokyo: "Saturday, October 17, at 11:05 AM." |
| 4 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 3 oddities. missingWords: p2: missing now; missingWords: last: missing were just; recapMissesLatest: you were asking what time it is in tokyo, and then you asked for the capital of france.; tokyo: "In Tokyo, it's Saturday October 17th,11:07 in the morning." |
| 5 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 1 oddities. recapMissesLatest: you asked me for the current time in tokyo and the capital of france.; tokyo: "It's 11:09 AM on Saturday in Tokyo." |
| 6 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 2 oddities. missingWords: p2: missing now; recapMissesLatest: the current time in tokyo, and that paris is the capital of france.; tokyo: "Saturday, October 17th at 11:11 in the morning, Japan time." |
| 7 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 1 oddities. missingWords: p2: missing now; tokyo: "It’s Saturday, October 17th, 11:13 in the morning in Tokyo." |
| 8 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 0 oddities. tokyo: "In Tokyo, it’s Saturday, October17th,11:15 in the morning." |
| 9 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 1 oddities. missingWords: p2: missing now; tokyo: "Saturday, October 17th, 11:17 in the morning, Japan time." |
| 10 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 1 oddities. missingWords: p2: missing now; tokyo: "Saturday, October 17th, 11:19 AM." |
| 11 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 2 oddities. missingWords: p2: missing now; greetingStatus: Good. Nothing's running.; tokyo: "It's11:21 a.m. in Tokyo, Japan time." |
| 12 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 2 oddities. missingWords: p2: missing now; recapMissesLatest: we weren't on a specific topic, you just said stop.; tokyo: "Saturday, October 17 at 11:23 a.m." |
| 13 | **FAIL** | ok | ok | ok | ok | **FAIL** | **FAIL** | ok | ok | 4 oddities. FAIL resultOnceEnglish reads=2 deliveries=injected,injected; FAIL franceParis said "Checking that."; missingWords: p2: missing now; missingWords: france: missing while that's running what's the capital of; missingWords: last: missing okay thanks what; recapMissesLatest: the current time in tokyo.; tokyo: "Saturday, October 17th, 11:25 AM, in Tokyo." |
| 14 | **FAIL** | ok | ok | ok | ok | **FAIL** | ok | ok | ok | 3 oddities. FAIL franceParis said ""; missingWords: france: missing while running what's the capital of france; slowAnswer: france: 6319 ms; recapMissesLatest: we were talking about the current time in tokyo.; tokyo: "It's 11:27 AM, and it's Saturday." |
| 15 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 2 oddities. greetingStatus: Nothing’s running right now.; recapMissesLatest: you'd just asked what time it is in tokyo, and then asked, while that's running, what's the capital of france?; tokyo: "Saturday, October 17th at 11:29 in the morning." |
| 16 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 3 oddities. missingWords: p2: missing now; greetingStatus: No task is running right now. So, nothing is in progress.; recapMissesLatest: you'd asked for the current time in tokyo, and then asked about the capital of france.; tokyo: "11:31 AM on Saturday, October 17, in Tokyo." |
| 17 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 2 oddities. missingWords: p2: missing now; recapMissesLatest: you'd asked what time it is in tokyo, and then asked for the capital of france.; tokyo: "In Tokyo, it’s Saturday, October 17th at 11:33 in the morning." |
| 18 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 3 oddities. missingWords: p2: missing now; greetingStatus: Nothing’s running right now.; recapMissesLatest: you asked how to read a file's contents on this server, and i said we'd get the file contents. you then said stop, so i held off.; tokyo: "It's Saturday, October 17, at 11:35 AM in Tokyo." |
| 19 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 4 oddities. missingWords: p2: missing now; missingWords: last: missing okay thanks what were; greetingStatus: Good — quiet right now. No task is running at the moment.; recapMissesLatest: you'd asked what time it is in tokyo and then the capital of france.; tokyo: "It’s11:36 a.m. in Tokyo." |
| 20 | PASS | ok | ok | ok | ok | ok | ok | ok | ok | 2 oddities. missingWords: p2: missing right now; greetingStatus: Good, nothing's running right now.; tokyo: "It’s 11:38 AM in Tokyo." |

## Patterns seen (counts out of 20 runs)

| # | pattern | count | scored as | notes |
| --- | --- | --- | --- | --- |
| 1 | The voice starts answering at "Tokyo", over the user's last words "right now"; those words then never reach the user transcript | 15 runs | `missingWords p2` | The voice's first word starts 400-1200 ms (audio clock `start_ms`) after the start of "Tokyo", the time "right now" takes to say; the app's clock line (`session.thinking.append clock`) went out 0.5-1.8 s before the answer's first fragment arrived, in all 20 runs |
| 2 | "What were we just talking about?" recaps only Tokyo/France, not the disk-space result read just before | 13 runs | `recapMissesLatest` | 2 recaps were wrong outright: "Your server running low on disk space" (run 7: 81% used is not "low"), "You asked how to read a file's contents on this server" (run 18: never said); 1 said "We weren't on a specific topic" (run 12) |
| 3 | The greeting reply is task status: "Nothing's running right now", "No task is running right now. So, nothing is in progress." | 7 runs | `greetingStatus` | no time in it, so `hiNoTime` passes |
| 4 | The France question is not heard ("Now France", "That's righ"); no app send within 4 s of it, 47-49 RTP packets/s | 2 runs (13, 14) | 3 failed checks | run 13: the voice handed "Now France" to Hermes ("Checking that."), which re-ran the disk check, so the result was read twice (2 jobs, 2 deliveries) |
| 5 | Other words not in the user transcript: "Okay, thanks. What were …" partly lost | 3 runs | `missingWords last` | answered anyway |
| 6 | The Tokyo answer leads with the date: "Saturday, October 17th, 11:25 AM, in Tokyo"; 4 never name Tokyo or Japan | 16 runs | not scored | correct to the minute in 20/20 |
| 7 | Hermes's result starts "V, …" (or "V, quick update:"), read as is | 16 runs | not scored | backend wording, not the voice app |
| 8 | Log trace has no `delegation received` line for the typed task | 19 runs | not scored | typed tasks don't come from a voice delegation; run 13 (spoken handoff) has it |
| 9 | Slow answer over 3 s | 1 run (14, the unheard France question) | `slowAnswer` | every other answer started within 3 s |

Baseline for Phase B, per 10 runs: **1.5 failed checks, 20.5 oddities** (3 and 41 in 20).
