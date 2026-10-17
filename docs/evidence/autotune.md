# Evidence: autotune (Phase B), Oct 17, 2026

Method: one change at a time to app code only (`web/*.js`, `src/live/policy.js`), each citing a
documented GPT-Live mechanism, then 10 live calls with `scripts/live-e2e/convo.mjs` (judge, harness,
cleanup and `convo-oddities.mjs` unchanged). Score = failed checks + oddities over the 10 calls.
KEEP only if the score goes strictly down and no check regresses; otherwise `git reset --hard` to
the last kept commit, restart and log a discard. Branch `autotune/oct17`. Each call is its own test
conversation with `cleanup.mjs` after it; V's conversation got `owner+0` in every call. The service was
restarted only with 0 jobs in `queued/running/awaiting_permission`, after a timestamped copy of
`state.sqlite` (`state.sqlite.20261017T…Z`, same folder).

## Result

**Nothing is merged, and the live service still runs `claude/voice-fixes` (build `15d58281245485b0`).**
The best kept commit, `386945b` (exp3 + exp6, build `f174394c619df048`), beats the Phase A conversation
numbers (per 10 calls: 0.5 failed checks + 11 oddities, against 1.5 + 20.5). It also matched the earlier
results on clock-zones (10/10) and fix1 (6/6). But on 5b it got 9/10 against the bar of 10/10: in one call
the voice began answering 200 ms before the user said "Tokyo". The same 5a/5b/5c set rerun on the live
build right after got 10/10. The Finish rule says every set must be at least as good, so the
tuned build was not merged or deployed. It stays on `autotune/oct17` for V to decide.

| | Phase A (build `15d58281`, 20 calls) | best kept `386945b` (20 calls) |
| --- | --- | --- |
| convo, every check | 18/20 | 19/20 |
| failed checks | 3 (1.5 per 10) | 1 (0.5 per 10) |
| oddities | 41 (20.5 per 10) | 22 (11 per 10) |
| greeting answered with task status (`greetingStatus`) | 7 | 0 |
| recap misses the result just read (`recapMissesLatest`) | 13 | 5 |
| voice talks over "right now" (`missingWords p2`) | 15 runs | 15 runs (`missingWords` 16 total) |
| clock zones | 10/10 (Oct 16) | 10/10 |
| fix1 1a-1f | 6/6 (Oct 16) | 6/6 |
| 5a / 5b / 5c | 10/10, 10/10, 10/10 (Oct 16); 10/10, 10/10, 10/10 rerun today | 10/10, **9/10**, 10/10 |

## results.tsv

```
commit	failures	runs	status	description
8c1790a	3	20	keep	baseline (Phase A, build 15d58281245485b0): oddities 41 in 20 runs; per 10: 1.5 failures + 20.5 oddities
eb4c9da	1	10	discard	exp1 no place-time send while the prompt world list is this minute (MS Learn What is GPT-Live: model decides when to respond; quiet context still influences speech): oddities 17 (base 20.5/10), score 18 vs 22, p2 talk-over 5/10 vs 15/20; but hiNoTime 1/10 vs 0/20 (greeting never heard, no app send near it) = check regression -> discard
6f24f98	1	10	discard	exp2 result commentary names the request it answers (MS Learn What is GPT-Live, Context management: supply task state when needed): score 19 (1+18) vs 22, no check regressed, but target recapMissesLatest 7/10 vs 6.5/10 unchanged; drop is greeting/missing-words noise the change cannot reach -> simplicity: discard
7797bf8	0	10	keep	exp3 call-start task status labeled for task questions, not greetings (MS Learn What is GPT-Live, How GPT-Live works: steer with session instructions): 0 failures + 13 oddities = 13 vs 22; greetingStatus 0/10 vs 7/20; no check regressed (10/10 pass, owner+0); convo-1792260245955.json
b865aad	1	10	discard	exp4 = exp1 again on exp3 (no place-time send while prompt world list is this minute; MS Learn Use GPT-Live, Add context: quiet context still influences speech): 1 failure + 10 oddities = 11 vs 13, missingWords p2 4/10 vs 6/10, but tokyoTime FAIL run 2 (noAnswer p2) = check regression -> discard; convo-1792261386885.json
109a56c	1	10	discard	exp5 recap policy: start with the last thing told, e.g. a result just read out (MS Learn What is GPT-Live, How GPT-Live works: session instructions steer the model): 1 failure + 11 oddities = 12 vs 13, recapMissesLatest 1/10 vs 7/10, but franceParis FAIL run 6 (France unheard, 6.9 s, Phase A pattern 4) = check regression -> discard; convo-1792262855131.json
386945b	0	10	keep	exp6 = exp5 recap policy re-measured on exp3 (MS Learn What is GPT-Live, How GPT-Live works: session instructions): 0 failures + 10 oddities = 10 vs 13; recapMissesLatest 3/10 vs 7/10; no check regressed (10/10 pass, owner+0); convo-1792263991167.json
e4a7f80	2	10	discard	exp7 named-place time line says it is quiet context, not a cue to speak (MS Learn Use GPT-Live, Add context: quiet context influences later speech): 2 failures + 18 oddities = 20 vs 10; tokyoTime FAIL runs 2, 9 (noAnswer p2), missingWords p2 10/10 -> discard; convo-1792265170910.json
2d6d6be	3	10	discard	exp8 named-place time line held 800 ms for the last words, dropped once the voice answered (MS Learn Use GPT-Live, Add context): 3 failures + 7 oddities = 10 vs 10 (not lower); missingWords p2 0/10 vs 7/10, but franceParis FAIL runs 1, 5 (France unheard) and tokyoTime FAIL run 9 (said 3:02, was 5:03) = check regressions -> discard; convo-1792266389361.json
```

Discarded commits (`b865aad`, `109a56c`, `e4a7f80`, `2d6d6be`) were reset away and are not on any branch; their diffs are described below.

Stop rule: 8 experiments reached (no 20-in-a-row with 0 oddities). Every run finished well under 10
minutes; there were no crashes. exp1, exp2 and the baseline row come from the earlier worker, which was killed
for low memory during exp3. Their logs are `logs/live-e2e/autotune-exp1.log` and `autotune-exp2.log`.
exp3 was committed (`7797bf8`) but not measured before that kill, so it was measured here from the
start. Any partial exp3 log from the killed run was replaced by this one.

## What was kept, and why

- **exp3, `7797bf8`, `src/live/policy.js`:** the call-start task status line in the session prompt
  now says it is only for a question about tasks: "a greeting such as \"how's it going?\" gets a greeting
  back, never task status". Phase A pattern 3 (the greeting answered with "Nothing's running", 7 of
  20) went to 0 of 10, then 0 of 20 in the final set. MS Learn, "What is GPT-Live", "How GPT-Live
  works": steer the live model with a short set of session instructions.
- **exp6, `386945b`, `src/live/policy.js`:** a recap rule in the session prompt: "When the user asks what
  you were just talking about, start with the last thing you told them, such as a task result you just
  read out, then mention earlier topics; a stop is not a topic." Phase A pattern 2 (the recap leaves out
  the disk-space result, 13 of 20) fell to 1/10 (exp5), 3/10 (exp6) and 5/20 in the final set. Same
  MS Learn mechanism. exp5 was the same change; it was discarded because of one unheard France
  question (Phase A pattern 4), and exp6 measured it again.

## What was tried and discarded

- exp1 / exp4 (same change, measured twice): no place-time line while the prompt's world list is
  still this minute. Talk-over went down (`missingWords p2` 4/10), but the Tokyo question then went
  unanswered once in each set (hiNoTime in exp1, tokyoTime in exp4).
- exp2: the result commentary names the request it answers. No change in the recap target.
- exp7: the place-time line says it is quiet context, not a cue to speak. Worse (score 20): the
  Tokyo question went unanswered twice.
- exp8: the place-time line waits 800 ms and is dropped once the voice has answered. Talk-over
  went from 7/10 to **0/10**, but France went unheard twice and one Tokyo answer was 2 hours off
  (score 10, equal to exp6, not lower). It is the most promising lead for the remaining
  pattern, but it was not kept.

## Before / after: raw output

### Phase A baseline

`docs/evidence/convo-20.md` (build `15d58281245485b0`, `logs/live-e2e/convo-1792202491304.json`):
`SUMMARY 18/20`, `ODDITIES 41 in 20 runs {"recapMissesLatest":13,"missingWords":20,"greetingStatus":7,"slowAnswer":1}`.

### exp3

Command: `node scripts/live-e2e/convo.mjs 10` (log `logs/live-e2e/autotune-exp3.log`), then `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792260245955.json`. Raw output:

```
1 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
2 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
3 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
4 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
5 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
6 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
7 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
8 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
9 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
10 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
SUMMARY 10/10 conversations pass every check | build 2bbfd28d5024b80c
1 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] the current time in tokyo, and the capital of france.
2 PASS oddities=1 [missingWords] p2: missing right
3 PASS oddities=0 
4 PASS oddities=1 [missingWords] p2: missing right now
5 PASS oddities=1 [recapMissesLatest] you asked what time it is in tokyo and i told you, and then you asked for the capital of france.
6 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] the current time in tokyo and the capital of france.
7 PASS oddities=2 [missingWords] p2: missing right now | [recapMissesLatest] we weren't talking about anything yet. you just said “stop.”
8 PASS oddities=1 [recapMissesLatest] you asked for the current time in tokyo, and then you asked for the capital of france.
9 PASS oddities=2 [missingWords] p2: missing right | [recapMissesLatest] you had just asked what time it is in tokyo, and then you said stop.
10 PASS oddities=1 [recapMissesLatest] you'd just asked what time it is in tokyo and about the capital of france.
ODDITIES 13 in 10 runs {"missingWords":6,"recapMissesLatest":7}
```

### exp4

Command: `node scripts/live-e2e/convo.mjs 10` (log `logs/live-e2e/autotune-exp4.log`), then `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792261386885.json`. Raw output:

```
1 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
2 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=FAIL franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
3 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
4 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
5 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
6 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
7 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
8 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
9 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
10 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
SUMMARY 9/10 conversations pass every check | build 77bdff18d8068bf3
1 PASS oddities=2 [longAnswer] tokyo: Lemme check. It’s 3:23 AM Sunday in Tokyo. | [recapMissesLatest] you'd just asked about the current time in tokyo.
2 FAIL oddities=2 [noAnswer] p2 | [recapMissesLatest] you'd asked for the capital of france, and i said paris.
3 PASS oddities=0 
4 PASS oddities=0 
5 PASS oddities=1 [recapMissesLatest] the capital of france.
6 PASS oddities=1 [missingWords] p2: missing now
7 PASS oddities=1 [missingWords] p2: missing now
8 PASS oddities=1 [missingWords] p2: missing right now
9 PASS oddities=1 [missingWords] p2: missing now
10 PASS oddities=1 [recapMissesLatest] we were talking about the current time in tokyo (3:40 am sunday) and that paris is the capital of france.
ODDITIES 10 in 10 runs {"longAnswer":1,"recapMissesLatest":4,"noAnswer":1,"missingWords":4}
```

### exp5

Command: `node scripts/live-e2e/convo.mjs 10` (log `logs/live-e2e/autotune-exp5.log`), then `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792262855131.json`. Raw output:

```
1 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
2 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
3 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
4 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
5 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
6 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=FAIL resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
7 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
8 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
9 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
10 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
SUMMARY 9/10 conversations pass every check | build f174394c619df048
1 PASS oddities=1 [missingWords] p2: missing right now
2 PASS oddities=1 [missingWords] p2: missing right now
3 PASS oddities=1 [missingWords] p2: missing now
4 PASS oddities=0 
5 PASS oddities=0 
6 FAIL oddities=3 [missingWords] p2: missing now | [missingWords] france: missing running what's the capital of france | [slowAnswer] france: 6914 ms
7 PASS oddities=1 [missingWords] p2: missing now
8 PASS oddities=1 [missingWords] p2: missing now
9 PASS oddities=2 [missingWords] p2: missing right | [recapMissesLatest] you'd asked the current time in tokyo, then checked on a running task and asked for the capital of france.
10 PASS oddities=1 [missingWords] p2: missing right
ODDITIES 11 in 10 runs {"missingWords":9,"slowAnswer":1,"recapMissesLatest":1}
```

### exp6

Command: `node scripts/live-e2e/convo.mjs 10` (log `logs/live-e2e/autotune-exp6.log`), then `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792263991167.json`. Raw output:

```
1 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
2 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
3 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
4 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
5 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
6 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
7 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
8 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
9 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
10 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
SUMMARY 10/10 conversations pass every check | build f174394c619df048
1 PASS oddities=1 [missingWords] p2: missing right now
2 PASS oddities=1 [missingWords] p2: missing now
3 PASS oddities=0 
4 PASS oddities=0 
5 PASS oddities=0 
6 PASS oddities=1 [missingWords] p2: missing right now
7 PASS oddities=2 [missingWords] p2: missing right now | [recapMissesLatest] you'd asked for the time in tokyo, and i said it's 4:18 am there. then you asked for the capital of france, and i said paris.
8 PASS oddities=2 [missingWords] p2: missing right now | [recapMissesLatest] i had just told you the current time in tokyo, and before that, confirmed the capital of france.
9 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] i had just told you the current time in tokyo. then we were on your question about the capital of france.
10 PASS oddities=1 [missingWords] p2: missing right now
ODDITIES 10 in 10 runs {"missingWords":7,"recapMissesLatest":3}
```

### exp7

Command: `node scripts/live-e2e/convo.mjs 10` (log `logs/live-e2e/autotune-exp7.log`), then `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792265170910.json`. Raw output:

```
1 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
2 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=FAIL franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
3 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
4 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
5 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
6 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
7 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
8 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
9 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=FAIL franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
10 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
SUMMARY 8/10 conversations pass every check | build 10a19e77efd63737
1 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] i'd just told you the time in tokyo, and before that, that the capital of france is paris.
2 FAIL oddities=3 [missingWords] p2: missing right now | [noAnswer] p2 | [recapMissesLatest] you asked for the capital of france, and i said, paris. i also mentioned that the server's main disc has 34 gig free and is 83 percent full.
3 PASS oddities=1 [missingWords] p2: missing now
4 PASS oddities=2 [missingWords] p2: missing right now | [recapMissesLatest] you asked for the current time in tokyo, then the capital of france. i said paris.
5 PASS oddities=1 [missingWords] p2: missing now
6 PASS oddities=2 [missingWords] p2: missing right now | [recapMissesLatest] we were talking about the time in tokyo and that paris is the capital of france.
7 PASS oddities=2 [missingWords] p2: missing right now | [recapMissesLatest] you'd asked what time it is in tokyo, and then while that was running, you asked about the capital of france.
8 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] you just asked for the time in tokyo. before that, you asked for the capital of france, which is paris.
9 FAIL oddities=2 [missingWords] p2: missing now | [noAnswer] p2
10 PASS oddities=1 [missingWords] p2: missing now
ODDITIES 18 in 10 runs {"missingWords":10,"recapMissesLatest":6,"noAnswer":2}
```

### exp8

Command: `node scripts/live-e2e/convo.mjs 10` (log `logs/live-e2e/autotune-exp8.log`), then `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792266389361.json`. Raw output:

```
1 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=FAIL resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
2 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
3 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
4 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
5 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=FAIL resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
6 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
7 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
8 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
9 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=FAIL franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
10 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
SUMMARY 7/10 conversations pass every check | build 6332783baddf6a07
1 FAIL oddities=2 [missingWords] france: missing while running what's the capital of france | [slowAnswer] france: 5160 ms
2 PASS oddities=1 [recapMissesLatest] i'd just told you the current time in japan and the capital of france.
3 PASS oddities=0 
4 PASS oddities=1 [recapMissesLatest] you asked for the current time in tokyo and then the capital of france.
5 FAIL oddities=2 [missingWords] france: missing what's the capital of france | [slowAnswer] france: 4436 ms
6 PASS oddities=0 
7 PASS oddities=0 
8 PASS oddities=0 
9 FAIL oddities=1 [recapMissesLatest] the time in tokyo.
10 PASS oddities=0 
ODDITIES 7 in 10 runs {"missingWords":2,"slowAnswer":2,"recapMissesLatest":3}
```

### Finish on the best kept commit `386945b` (build `f174394c619df048`)

Command: `node scripts/live-e2e/convo.mjs 20` (log `logs/live-e2e/autotune-finish-convo20.log`), then `node scripts/live-e2e/convo-oddities.mjs logs/live-e2e/convo-1792267616232.json`:

```
1 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
2 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
3 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
4 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
5 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
6 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
7 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
8 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
9 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
10 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
11 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
12 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
13 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
14 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
15 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
16 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
17 FAIL silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=FAIL resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
18 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
19 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
20 PASS silentOnConnect=ok silentInPause=ok hiNoTime=ok tokyoTime=ok franceParis=ok resultOnceEnglish=ok silentAfterStop=ok afterStopAnswered=ok owner+0
SUMMARY 19/20 conversations pass every check | build f174394c619df048
1 PASS oddities=1 [missingWords] p2: missing right
2 PASS oddities=2 [missingWords] p2: missing right | [recapMissesLatest] you asked me for the time in tokyo and then the capital of france.
3 PASS oddities=1 [recapMissesLatest] your question about the time in tokyo, and then you asked for the capital of france.
4 PASS oddities=1 [missingWords] p2: missing right
5 PASS oddities=1 [missingWords] p2: missing now
6 PASS oddities=1 [missingWords] p2: missing now
7 PASS oddities=1 [recapMissesLatest] you had just asked for the current time in tokyo, and then the capital of france.
8 PASS oddities=1 [missingWords] p2: missing now
9 PASS oddities=1 [missingWords] p2: missing now
10 PASS oddities=1 [missingWords] p2: missing right now
11 PASS oddities=0 
12 PASS oddities=0 
13 PASS oddities=1 [missingWords] p2: missing now
14 PASS oddities=2 [missingWords] p2: missing right now | [recapMissesLatest] you had just asked what time it is in tokyo, then asked for the capital of france.
15 PASS oddities=1 [missingWords] p2: missing right now
16 PASS oddities=0 
17 FAIL oddities=3 [missingWords] p2: missing now | [missingWords] france: missing what's the capital of france | [slowAnswer] france: 4614 ms
18 PASS oddities=1 [missingWords] p2: missing now
19 PASS oddities=2 [missingWords] p2: missing now | [recapMissesLatest] you asked me what time it is in tokyo, and then what the capital of france is.
20 PASS oddities=1 [missingWords] p2: missing right now
ODDITIES 22 in 20 runs {"missingWords":16,"recapMissesLatest":5,"slowAnswer":1}
```

Command: `node scripts/live-e2e/clock-zones.mjs 10` (log `logs/live-e2e/autotune-finish-clock.log`):

```
1 PASS Tokyo Asia/Tokyo expected "Sun 5:44 AM" spoken "5:43 am" off 1 min jobs 0 answer " It’s 5:43 a.m. Japan time."
2 PASS London Europe/London expected "Sat 9:45 PM" spoken "9:45 pm" off 0 min jobs 0 answer " It’s 9:45 PM in London."
3 PASS Sydney Australia/Sydney expected "Sun 7:46 AM" spoken "7:46 am" off 0 min jobs 0 answer " In Sydney, it's 7:46 AM on Sunday, October 18th."
4 PASS Kolkata Asia/Kolkata expected "Sun 2:18 AM" spoken "2:17 am" off 1 min jobs 0 answer " It's 2:17 AM in Kolkata."
5 PASS New York America/New_York expected "Sat 4:49 PM" spoken "4:49 pm" off 0 min jobs 0 answer " In New York, it's4:49 PM on Saturday."
6 PASS Auckland Pacific/Auckland expected "Sun 9:50 AM" spoken "9:50 am" off 0 min jobs 0 answer " It’s 9:50 AM in Auckland."
7 PASS Kathmandu Asia/Kathmandu expected "Sun 2:37 AM" spoken "2:37 am" off 0 min jobs 0 answer " It’s 2:37 AM in Kathmandu."
8 PASS Dubai Asia/Dubai expected "Sun 12:53 AM" spoken "twelve fifty three am" off 0 min jobs 0 answer " Twelve-fifty-three AM on Sunday."
9 PASS São Paulo America/Sao_Paulo expected "Sat 5:55 PM" spoken "five fifty four pm" off 1 min jobs 0 answer " Five fifty-four p.m."
10 PASS Paris Europe/Paris expected "Sat 10:56 PM" spoken "10:56 pm" off 0 min jobs 0 answer " It’s 10:56 PM in Paris."
SUMMARY 10/10 within 1 minute of Intl | Hermes jobs 0 | build f174394c619df048
Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/clock-zones-1792269832567.json
```

Command: `node scripts/live-e2e/fix1.mjs` (log `logs/live-e2e/autotune-finish-fix1.log`):

```
=== 1a PASS deliveries for earlier-call jobs=0; assistant turns in first 60 s=1; waiting lines=1
=== 1b PASS job A key word "the velvet asity"; assistant after yes: "The test bird is the velvet asity. It was seen at the east pond."
=== 1c PASS stop fragment start_ms=20400; assistant fragments starting >1 s after stop=0 (received in 30 s, incl. tail=0); new deliveries in 30 s=0; second result final and waiting=true
=== 1d PASS question fragment at 1792271043362
=== 1e PASS 
=== 1f PASS overlapping user fragments=0
Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix1-1792271063266.json
```

Command: `node scripts/live-e2e/fix5.mjs 5abc 10` (log `logs/live-e2e/autotune-finish-fix5.log`). Per-run pass flags, the user's last fragment start and each answer's start (audio clock, ms), taken from its VERDICT lines:

```
SUMMARY 5a 10/10 (need 10/10) | 5b 9/10 (need 10/10) | 5c 10/10 (need >=4/5) | latencies ms [400,0,600,200,0,0,400,0,0,0]
Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix5-5abc-1792271064151.json
1 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s 6:04 AM in Tokyo.', 8000)]
2 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7600 answers [("It's 6:06 AM on Sunday, October 18th, in Tokyo.", 7800)]
3 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('In Tokyo, it’s Sunday, October 18th, 6:07 in the morning.', 8200)]
4 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('In Tokyo, it’s 6:08 AM on Sunday, October 18th.', 7800)]
5 {'pass5a': True, 'pass5b': False, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s 6:10 in the morning, Japan time.', 7200)]
6 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [("It's 6:11 AM in Tokyo.", 7400)]
7 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('Sunday, October 18th,6:13 in the morning, Japan time.', 8000)]
8 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [("It's 6:14 AM on Sunday in Tokyo.", 7600)]
9 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s 6:16 in the morning, Sunday in Tokyo.', 7600)]
10 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('6:17 AM.', 7600)]
```

Run 5 fails 5b: the answer starts at 7200 ms, before the user's last word ("Tokyo", 7400 ms).

### Comparison: the same 5abc set on the live build `15d58281245485b0`, right after

Command: `node scripts/live-e2e/fix5.mjs 5abc 10` (log `logs/live-e2e/autotune-baseline-fix5.log`):

```
SUMMARY 5a 10/10 (need 10/10) | 5b 10/10 (need 10/10) | 5c 10/10 (need >=4/5) | latencies ms [0,800,0,0,0,0,0,0,600,0]
Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix5-5abc-1792271945224.json
1 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s 6:19 in Tokyo.', 7600)]
2 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s6:20 AM on Sunday, October 18th in Tokyo.', 8400)]
3 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s 6:22 AM in Tokyo.', 7400)]
4 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [("It's 6:23 AM in Tokyo.", 7400)]
5 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s 6:24 AM on Sunday in Tokyo, Japan time.', 7400)]
6 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('6:26 AM on Sunday, October18th in Tokyo.', 7400)]
7 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [("It's 6:27 AM in Tokyo.", 7400)]
8 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [("It's 6:29 a.m. on Sunday in Tokyo.", 7600)]
9 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [('It’s Sunday, October 18th, 6:30 in the morning in Tokyo.', 8200)]
10 {'pass5a': True, 'pass5b': True, 'pass5c': True} lastUser Tokyo 7400 answers [("It's 6:32 AM in Tokyo.", 7600)]
```

## Finish checks

| check | result | evidence |
| --- | --- | --- |
| convo ×20 at least as good as Phase A | PASS | 19/20 and 1 failed check + 22 oddities, against 18/20 and 3 + 41 |
| clock-zones ×10 | PASS | `SUMMARY 10/10 within 1 minute of Intl \| Hermes jobs 0` |
| fix1 once | PASS | 1a-1f all `PASS` |
| 5a/5b ×10 | **FAIL** | 5a 10/10, **5b 9/10** (the live build got 10/10 in the same hour) |
| merged to `claude/voice-fixes` and live | **not done** | blocked by the 5b result; the live service runs `15d58281245485b0` |

`npm run -s test:live`: 208/208 on `386945b`, and 206/206 on `claude/voice-fixes` before the final restart.

## Incident during this run

The first discard (`git reset --hard`, exp4) also wiped other sessions' uncommitted lines in
`CLAUDE.md`, `README.md` and `ledger.md`. All three were restored before anything else ran. `CLAUDE.md`
was rebuilt from the handoff writer's saved snapshot and entry, and its sha256 matches the writer's
recorded hash (`8901e13f…`). The README lines were rebuilt from the Hermes patch tool records. `ledger.md`
was rebuilt from an Oct 14 copy plus the Hermes read-back of lines 600-664; its byte size matches the
recorded 87,297. Later discards saved and restored these three files around the reset.

## Recheck (Oct 17, after the worker finished)

The tuned instructions (`src/live/policy.js` from 386945b) were put live alone (build `f174394c619df048`, 208/208 tests) and the pause set rerun: `node scripts/live-e2e/fix5.mjs 5abc 10` (log `logs/live-e2e/autotune-recheck-fix5.log`):

```
SUMMARY 5a 8/10 (need 10/10) | 5b 6/10 (need 10/10) | 5c 10/10 (need >=4/5) | latencies ms [0,400,200,600,0,0,0,0,200,1000]
```

Across both sets the tuned build is 5b 15/20, against 10/10 for the live build. Decision: **not merged**. Live is back on `15d58281245485b0`; V's conversation got 0 new fragments (10/10 runs).
