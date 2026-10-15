# Fix 7 evidence: handle a dropped call cleanly

Spec: `docs/VOICE-FIX-PLAN.md`, Fix 7, checks 7a–7c (Round 2 rules). Every live run was a real call against http://127.0.0.1:8787 in headless Chrome (`/usr/bin/google-chrome`, Playwright) with fake media flags. The microphone is Chrome's silent fake device with Azure Speech TTS WAVs (48 kHz mono) mixed in by `scripts/live-e2e/harness.mjs`. Calls ran one at a time, about a minute apart, each in its own test conversation (never V's `ccad5a2f-2433-4361-bfc8-bba14d7973e9`). Each ended with `scripts/live-e2e/cleanup.mjs`, and its `[cleanup]` and `[isolation]` lines are in the raw output below. Pass/fail is measured from `~/.local/state/jarvis-voice/state.sqlite` (`fragments`, `jobs`, `deliveries`, plus `audit` for the app's own cut-off records), opened read-only.

**Result: 7a PASS (3/3), 7b PASS (3/3), 7c PASS (1a and 1c pass; 1b, 1d, 1e and 1f pass too).** Live build `3a0ab18ca1e6c5ea` = the working tree of this commit (`/healthz` buildId equals the hash of `src/live/*.js` + `web/*.js`).

## How the drop is simulated

`Call.drop()` (harness) closes the page's live `RTCPeerConnection`, captured by an init-script wrapper around the constructor. It does not press End, so `wanted` stays true. In Chrome, a local `pc.close()` fires the data channel's `close` event (checked with a loopback pair: `dc.close` fires and the far side goes `disconnected`). That runs the app's own `reconnect("remote_channel_closed")` → `teardown()` → `start()` path, which is the same path `peer_disconnected` takes on Oct 13. The test (`scripts/live-e2e/fix7.mjs`) runs as follows:

1. Start a call, then type a background task. Hermes picks a random sea-bird species and writes six sentences. The first is "The harbor bird is <species>." Because Hermes writes the text, the voice cannot know it.
2. Wait for the app to offer the result (`result.offered`) and for the voice's first transcript word of it (`/harbor|bird/`).
3. Two seconds later, drop the connection.
4. Wait 25 s in silence (7a), then say the WAV "Yes, finish." (7b).

### Scoring (`scripts/live-e2e/fix7-judge.mjs`, pinned in `tests/live/reconnect.test.mjs`)
- **7a**: look at every assistant fragment of the reconnected session received before the user's "yes" fragment. Pass = there are none, **or** exactly one turn that asks once ("cut off" once, "finish" once). In both cases, none of the cut-off answer's distinctive words (≥5 letters, from the job result and from what the dropped session said) may appear, so a resumed sentence always fails.
- **7b**: look at the assistant speech after the "yes" fragment. Pass needs all of these:
  - it contains the Hermes-chosen species and ≥80% of the result's distinctive words;
  - the `deliveries` row for the job is `injected` in the reconnected session, updated after the yes;
  - before that injection the voice said at most 3 words ("Okay.");
  - the result's last sentence was said at most once;
  - no new job was created in the reconnected session (no re-run).

## What changed

1. **Reconnect history** (`src/live/store.js`, `src/live/server.js`). The page tells the server, on the reconnect's `/api/live`, which session dropped mid-speech (`cutOff: { session, job }`). Only the conversation's current active session is accepted. `store.cutOff()` records an audit row `session.cut_off` and turns the result being read into delivery state `cut_off`. Every later `liveHistory()` replay marks the last assistant turn of a cut-off session: whole sentences are kept, the half sentence is dropped, and `[Cut off here: the connection dropped and the user did not hear the rest. Do not continue, repeat or mention this answer on your own.]` is appended. The model has nothing half-said left to continue.
2. **Silent until V speaks, plus one offer** (`web/live.js`, `web/delivery-policy.js`).
   - **Detecting a cut-off.** On `connection.lost`, the page counts the answer as cut off if speaker audio played within the last 1 s or a transcript word arrived within the last 2 s. The result counts as "being read" until 1.5 s of speaker silence after it began. The earlier 300 ms gap only marked a pause between sentences (seen live, run 2 of iteration 2).
   - **The offer.** At the first 2 s pause after reconnect, the app sends the single line "We got cut off. Want me to finish what I was saying?" through the same commentary and consent path as Fix 1's waiting line.
   - **After "yes".** The cut-off result is offered again (`cut_off` → `offered` → `injected`) at once, without waiting for a pause. If the cut-off answer was the model's own, the model is told to give the whole answer again.
   - **After "no".** Nothing is said, and a `cut_off` result is never pushed on its own.
   - **Handoff guard.** If the voice hands "yes, finish" to the backend, the app answers that handoff quietly (`session.thinking.append` with its delegation id) and creates no job. This happened in all 3 final runs (`delegation.cut_off_reply` in `audit`). Without the guard, Hermes re-ran the task and the answer was read twice.
3. **Speech instructions** (`src/live/policy.js`): one sentence: "An earlier answer marked cut off was interrupted by a dropped connection: never continue, finish, repeat or offer to finish it on your own, and never hand finishing it to the backend; the app asks the user and supplies it." The Fix 1 silent-connect, Fix 5 turn-taking and Fix 6 claims text are unchanged.
4. **No schema change.** `cut_off` is a new value in the existing `deliveries.state` column, and `session.cut_off` is a new `audit` kind. Before the first restart, the database was backed up to `~/.local/state/jarvis-voice/state.sqlite.bak-fix7-20261015T194926Z` (`VACUUM INTO`, mode 600). Each restart was preceded by `SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running','awaiting_permission')` = 0 (printed as `active jobs: 0`).

## Code checks

`npm run -s test:live` after the last code change (`logs/live-e2e/fix7-tests.log`, git-ignored; Fix 7 tests and totals):

```
✔ 7a: the cut-off answer keeps only whole sentences and is marked cut off in the replayed history (3.708825ms)
✔ 7a/7b: a result cut off mid-read becomes cut_off, is never pushed again, and can be offered once more (135.299582ms)
✔ 7a: after a drop the reconnected session is silent, then offers to finish exactly once (1.797984ms)
✔ 7b: 'yes, finish' brings the cut-off result back in full; a 'no' leaves it unspoken (5.214964ms)
✔ 7b: when the cut-off answer was the model's own, yes asks it to give the whole answer again (3.64232ms)
✔ 7b: the voice handing 'yes, finish' to the backend is answered by the app, not run again (0.814662ms)
✔ 7c: a stop still silences the offer (Fix 1) (0.444491ms)
✔ 7a: speech instructions forbid continuing a cut-off answer; the page reports the drop (39.080677ms)
✔ 7a: /api/live with cutOff sends the replayed history with the cut-off answer marked (417.009142ms)
✔ judge 7a: silence or the single offer passes; a resumed sentence fails (1.423395ms)
✔ judge 7b: the key word, 80% of the result's words and a re-delivery after the yes (0.696718ms)
ℹ tests 145
ℹ suites 0
ℹ pass 145
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13364.317013
exit=0
```

## 7a baseline (before any change): build `299767970068e4c8` = commit 9abcf4c

Command: `node scripts/live-e2e/fix7.mjs 3`, run twice against the unchanged service.

Baseline v1 (`logs/live-e2e/fix7-baseline.log`) used a request that contained the result sentences verbatim, so the voice could speak them itself. The harness was then changed so that only Hermes writes the text. Its 7a outcome is still a real observation of the old build:

```
=== run 1: test run fix7-mv9xqo77, conversation 77f36ab4-062d-4f80-9b20-25a8688d22dd, session live_EZLTPCUUYpaGvScWp6DZd
dropped at 1792092756171 (2003 ms into the answer); reconnected session live_EZLTpoeYvi7uH0yxsEYfT at 1792092758661
7a run 1: PASS {"pass":true,"silent":true,"offerOnly":false,"first":"","turns":0,"resumed":[]}
7b run 1: FAIL {"pass":false,"coverage":0.86,"hasKey":false,"redelivered":false,"missing":["harbor","legged","kittiwake"]}
[isolation] owner conversation new fragments: 0
=== run 2: test run fix7-mv9xuljx, conversation e0f5dda0-3a8a-4dcb-ab09-679d31d106e6, session live_EZLWNq2gaS4rkwibRlN26
dropped at 1792092930498 (2004 ms into the answer); reconnected session live_EZLWegkm0UkMIqleZUXcD at 1792092933260
7a run 2: PASS {"pass":true,"silent":true,"offerOnly":false,"first":"","turns":0,"resumed":[]}
7b run 2: FAIL {"pass":false,"coverage":0.87,"hasKey":false,"redelivered":false,"missing":["harbor","swinhoe","petrel"]}
[isolation] owner conversation new fragments: 0
=== run 3: test run fix7-mv9xyca7, conversation e569a081-06ad-4f21-8fa1-74b3ad71d208, session live_EZLZBzFD3m99493eeZVxU
dropped at 1792093104465 (2003 ms into the answer); reconnected session live_EZLZSIOhT1bDElfwxKtel at 1792093107051
7a run 3: FAIL {"pass":false,"silent":false,"offerOnly":false,"first":"It nests on the old lighthouse every spring. The keeper counts the nests each morning and writes them in a green notebook. Last year there were forty two nests, the most in a decade. This year the count is lower because of the storms in April. The keeper expects the colony to recover by next summer. Final","turns":1,"resumed":[
7b run 3: FAIL {"pass":false,"coverage":0,"hasKey":false,"redelivered":false,"missing":["harbor","bulwer's","petrel","nests","lighthouse","spring","keeper","counts","morning","writes","green","notebook","forty","decade","count","lower","storms","april","expects","colony","recover","summer"]}
[isolation] owner conversation new fragments: 0
SUMMARY 7a 2/3 PASS, 7b 0/3 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792093201414.json
exit=0
```

Run 3 is the Oct 13 failure, reproduced exactly. The reconnected session's very first words were the rest of the cut-off answer (raw fragments, first 40 rows):

```
--- reconnected session s2 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZLZSIOhT1bDElfwxKtel])
1792093107433 assistant [0-200] " It nests"
1792093108135 assistant [200-400] " on the"
1792093108137 assistant [400-600] " old lighthouse"
1792093108833 assistant [1000-1200] " every"
1792093108834 assistant [1200-1400] " spring."
1792093110232 assistant [2400-2600] " The keeper"
1792093110234 assistant [2600-2800] " counts"
1792093110234 assistant [2800-3000] " the"
1792093110933 assistant [3000-3200] " nests"
1792093110935 assistant [3200-3400] " each"
1792093110936 assistant [3400-3600] " morning"
1792093111632 assistant [4000-4200] " and writes"
1792093111634 assistant [4200-4400] " them"
1792093112333 assistant [4400-4600] " in a"
1792093112334 assistant [4600-4800] " green"
1792093112335 assistant [4800-5000] " notebook."
1792093113743 assistant [6000-6200] " Last"
1792093113765 assistant [6200-6400] " year"
1792093113858 assistant [6400-6600] " there"
1792093114468 assistant [6600-6800] " were forty"
1792093114495 assistant [7000-7200] " two"
1792093115162 assistant [7200-7400] " nests,"
1792093115216 assistant [7600-7800] " the"
1792093115255 assistant [7800-8000] " most"
1792093115837 assistant [8200-8400] " in a"
1792093115839 assistant [8400-8600] " decade."
1792093117233 assistant [9400-9600] " This"
1792093117236 assistant [9600-9800] " year"
1792093117237 assistant [9800-10000] " the"
1792093117934 assistant [10000-10200] " count"
1792093117936 assistant [10200-10400] " is"
1792093117938 assistant [10400-10600] " lower"
1792093118633 assistant [10600-10800] " because"
1792093118636 assistant [10800-11000] " of"
1792093118637 assistant [11000-11200] " the storms"
1792093119332 assistant [11400-11600] " in April"
1792093119337 assistant [11600-11800] "."
1792093120733 assistant [12800-13000] " The"
1792093120735 assistant [13000-13200] " keeper"
1792093120736 assistant [13200-13400] " expects"
1792093121432 assistant [13600-13800] " the colony"
1792093121435 assistant [14000-14200] " to"
1792093122132 assistant [14200-14400] " recover"
1792093122134 assistant [14600-14800] " by next"
1792093122832 assistant [14800-15000] " summer."
1792093122834 assistant [15200-15400] " Final"
1792093134033 user      [26200-26400] " Yes"
1792093134034 user      [26600-26800] ", finish"
1792093135432 assistant [27600-27800] " Done."

```

Baseline v2 (`logs/live-e2e/fix7-baseline2.log`, final harness):

```
=== run 1: test run fix7-mv9y22nt, conversation 773578c0-de98-4874-89c7-dd464c4b935e, session live_EZLbzGubYuJZb7G4mmzrZ
dropped at 1792093293629 (2004 ms into the answer); reconnected session live_EZLcVmmTfTEGzRg8KHpxf at 1792093296056
7a run 1: PASS {"pass":true,"silent":true,"offerOnly":false,"first":"","turns":0,"resumed":[]}
7b run 1: FAIL {"pass":false,"coverage":0.53,"hasKey":true,"redelivered":false,"missing":["marked","stained","scrap","ribbon","watched","lantern","during","heart"]}
[isolation] owner conversation new fragments: 0
=== run 2: test run fix7-mv9y646p, conversation 5b78171b-45b8-4a2e-bf3a-fcc9afe00098, session live_EZLf2zpVXVZcFWV7iCJcw
dropped at 1792093480940 (2005 ms into the answer); reconnected session live_EZLfWpGip4VGWgEpeMeRV at 1792093483448
7a run 2: PASS {"pass":true,"silent":true,"offerOnly":false,"first":"","turns":0,"resumed":[]}
7b run 2: FAIL {"pass":false,"coverage":0.32,"hasKey":true,"redelivered":false,"missing":["spring","lighthouse","seventeen","clung","eastern","spotted","three","ribbons","rocks","morning","checked","through","brass","binoculars","recorded","stained","notebook"]}
[isolation] owner conversation new fragments: 0
=== run 3: test run fix7-mv9ya4sv, conversation 37a6df34-e29a-4880-8250-d54cb6b1a75a, session live_EZLi3G4XTiIMFozTuRRes
dropped at 1792093655015 (2005 ms into the answer); reconnected session live_EZLiKQSEKFVRb4853N8TS at 1792093657491
7a run 3: PASS {"pass":true,"silent":true,"offerOnly":false,"first":"","turns":0,"resumed":[]}
7b run 3: FAIL {"pass":false,"coverage":0.27,"hasKey":true,"redelivered":false,"missing":["spring","lighthouse","keeper","counted","seventeen","beneath","stone","steps","sheltered","beside","rusty","behind","keeper's","cabbage","patch","pebble"]}
[isolation] owner conversation new fragments: 0
SUMMARY 7a 3/3 PASS, 7b 0/3 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792093751833.json
exit=0
```

**Baseline: 5 of 6 reconnects were silent and 1 resumed the old sentence (7a FAIL in that run). No run could get the answer back (7b 0/6).**

## Iterations on the fixed build (failures kept)

Each iteration below is `node scripts/live-e2e/fix7.mjs 3` after a restart onto the build named.

- **Iteration 1** (`07548cd5ec39e9f7`, `logs/live-e2e/fix7-after.log`): 7a 3/3, 7b 3/3 by the first judge. The transcripts still showed two defects. In run 1 the result was read twice. In run 2 the voice made up its own version after "Okay" while the app waited 19 s for a pause before re-delivering. **Change:** re-deliver at once after the yes, tighten the offer and resume wording, and make the judge fail made-up speech before the injection.
```
=== run 1: test run fix7-mv9yd3ti, conversation 228f34b2-1b71-40cc-801a-82cd0c4b30a4, session live_EZLkIu9qfm3f71kKTmr4K
dropped at 1792093795748 (2007 ms into the answer); reconnected session live_EZLkbUexNlklFzxBiyYiE at 1792093798310
7a run 1: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 1: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"missing":[]}
[isolation] owner conversation new fragments: 0
=== run 2: test run fix7-mv9yg6uj, conversation 5727aa6c-7605-4694-a1b3-26a835d32f55, session live_EZLmcRianBVy9V7DxExO5
dropped at 1792093949631 (2005 ms into the answer); reconnected session live_EZLn50MzXHzwJu9M7okpp at 1792093952613
7a run 2: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 2: PASS {"pass":true,"coverage":0.95,"hasKey":true,"redelivered":true,"missing":["seventeen"]}
[isolation] owner conversation new fragments: 0
=== run 3: test run fix7-mv9yjp2y, conversation b8b67298-f2cf-452f-b19d-8e0ffdcf02d8, session live_EZLpFYCGGdS99bdiP9AQ0
dropped at 1792094105019 (2012 ms into the answer); reconnected session live_EZLpaeG1xzqJbQmgN9X6X at 1792094107472
7a run 3: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 3: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"missing":[]}
[isolation] owner conversation new fragments: 0
SUMMARY 7a 3/3 PASS, 7b 3/3 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792094158817.json
exit=0
```
- **Iteration 2** (`0bff92471d62f25c`, `logs/live-e2e/fix7-after2.log`): 7b 1/3. In run 2 the "being read" marker was cleared by a 300 ms pause between sentences, so the drop was reported with no job. The voice then started a new job (`audit`: `session.cut_off` `{"job":null}`, and a second `jobs` row in the new session). Run 1's voice stream stalled mid-result. **Change:** "being read" now ends only after 1.5 s of speaker silence.
```
=== run 1: test run fix7-mv9yoccg, conversation c0c51cf3-c78e-40a2-b879-8cdb44bc20a5, session live_EZLsky7OmHefv7SKNe8JD
dropped at 1792094319787 (2009 ms into the answer); reconnected session live_EZLt3HSrhPR51YQnpPpyO at 1792094322966
7a run 1: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 1: FAIL {"pass":false,"coverage":0.19,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":0,"missing":["lighthouse","keeper","counted","seventeen","nests","beneath","western","cliffs","marked","entrance","pebble","notebook","smelled","orange","behind","brass","lantern","returned","friday","socks","pencil"]}
[isolation] owner conversation new fragments: 0
=== run 2: test run fix7-mv9yrc0e, conversation a9b2d472-5af9-4cd8-a4c9-31e1f1c14675, session live_EZLuzxKQIBnFKtDTlHrxe
dropped at 1792094459062 (2015 ms into the answer); reconnected session live_EZLvIZkiTbeENqDrIRknE at 1792094461692
7a run 2: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 2: FAIL {"pass":false,"coverage":1,"hasKey":true,"redelivered":false,"earlyWords":0,"repeats":1,"missing":[]}
[isolation] owner conversation new fragments: 0
=== run 3: test run fix7-mv9yv3pa, conversation 2fb65b47-85d4-45b9-9efd-6bcc7e69c7a5, session live_EZLxpjmIgCfGw5GllRwgn
dropped at 1792094633383 (2005 ms into the answer); reconnected session live_EZLy6W9mIRElc6andHdo2 at 1792094644801
7a run 3: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 3: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":1,"missing":[]}
[isolation] owner conversation new fragments: 0
SUMMARY 7a 3/3 PASS, 7b 1/3 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792094712058.json
exit=0
```
- **Iteration 3** (`9c7a03c0868db76b`, `logs/live-e2e/fix7-after3.log`): 7a 3/3 and 7b 3/3 by that judge, but there were two defects. In runs 1 and 3 the result was read twice: the `jobs` table shows the voice handed "Yes, finish" to Hermes (delegation `item_…` created at the yes), Hermes repeated the text, and the app delivered it as a new result. Run 1 also opened with the voice's own offer before the app's line. **Change:** the handoff guard, the instruction and note wording, and judges that fail two offers, a double read or a re-run job.
```
=== run 1: test run fix7-mv9yz6pj, conversation f357b532-574e-452e-99bb-e3b856130f71, session live_EZM0udxn8VWRjrJfYkXiw
dropped at 1792094823831 (2003 ms into the answer); reconnected session live_EZM1BHnQt76tgqMgVWiN9 at 1792094826750
7a run 1: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"It looks like my last reply was cut off. Would you like me to finish it? We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 1: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":2,"missing":[]}
[isolation] owner conversation new fragments: 0
=== run 2: test run fix7-mv9z2igv, conversation 5cfcb7cb-2560-484f-8c6c-8d93548727d4, session live_EZM3P8NPbzH5VZ4ND7H3c
dropped at 1792094979562 (2012 ms into the answer); reconnected session live_EZM3hMNdw8bBFw6GNRUQk at 1792094982273
7a run 2: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 2: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":1,"missing":[]}
[isolation] owner conversation new fragments: 0
=== run 3: test run fix7-mv9z5a61, conversation 1873ab93-1b01-4730-9ef4-25e5a0c42b70, session live_EZM5UohfRWdKqglC3eD2u
dropped at 1792095109326 (2005 ms into the answer); reconnected session live_EZM5mSPCwXpn4LR10c60C at 1792095111903
7a run 3: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 3: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":2,"missing":[]}
[isolation] owner conversation new fragments: 0
SUMMARY 7a 3/3 PASS, 7b 3/3 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792095174481.json
exit=0
```

## 7a and 7b: final runs, build `3a0ab18ca1e6c5ea`

Command: `node scripts/live-e2e/fix7.mjs 3` (`logs/live-e2e/fix7-after4.log`). Complete raw output: per run, the job row, both sessions' fragments, the delivery row, jobs created in the reconnected session, the cut-off audit rows, both verdicts, and the cleanup and isolation lines.

```

=== run 1: test run fix7-mv9zagfq, conversation 92357be8-6be7-4e03-bb66-c4e9352db2c6, session live_EZM9OsB7NJ4p949wtKVDk
dropped at 1792095354411 (2006 ms into the answer); reconnected session live_EZM9jO23gxJmFbNYSBNp1 at 1792095356925
SQL: SELECT id,session,state,result,created,updated FROM jobs WHERE id=? [be1a487a-f441-47f7-9c36-12892e87731c]
{
 "id": "be1a487a-f441-47f7-9c36-12892e87731c",
 "session": "live_EZM9OsB7NJ4p949wtKVDk",
 "state": "completed",
 "result": "The harbor bird is the red-legged kittiwake. This spring, lighthouse keeper Mara counted seventeen nests. Nine rested below the lantern room. Five clung to a narrow cliff ledge. Three hid behind the old fog bell. Mara marked each nest in her blue notebook.",
 "created": 1792095338459,
 "updated": 1792095351843
}
--- dropped session s1 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZM9OsB7NJ4p949wtKVDk])
1792095338456 user      [1792095338446-1792095338446] "Automated voice test for Hermes. Choose one random uncommon sea bird species yourself. Then write six short plain sentences about a lighthouse keeper counting that bird's nests this spring, with made-up numbers and details. The first sentence must be exactly: The harbor bird is <the species>. Reply with only those six sentences, without using any tools."
1792095339133 assistant [3400-3600] " Hey,"
1792095339833 assistant [3600-3800] " V."
1792095339837 assistant [3800-4000] " Hermes"
1792095340535 assistant [4400-4600] " is"
1792095340537 assistant [4600-4800] " working"
1792095341233 assistant [5000-5200] " on that"
1792095341241 assistant [5200-5400] " one."
1792095352432 assistant [16800-17000] " The harbor"
1792095353132 assistant [17000-17200] " bird"
1792095353135 assistant [17200-17400] " is"
1792095353136 assistant [17400-17600] " the"
1792095353832 assistant [17600-17800] " red-legged"
1792095353834 assistant [18200-18400] " kitt"
1792095354534 assistant [18400-18600] "iwake"
1792095354538 assistant [18600-18800] "."
--- reconnected session s2 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZM9jO23gxJmFbNYSBNp1])
1792095359432 assistant [1800-2000] "We got"
1792095359436 assistant [2000-2200] " cut off"
1792095359436 assistant [2200-2400] "."
1792095360133 assistant [2600-2800] " Want"
1792095360144 assistant [2800-3000] " me"
1792095360833 assistant [3000-3200] " to"
1792095360839 assistant [3200-3400] " finish"
1792095361546 assistant [3600-3800] " what I"
1792095361548 assistant [3800-4000] " was saying"
1792095361550 assistant [4000-4200] "?"
1792095383232 user      [26000-26200] " Yes"
1792095383932 user      [26600-26800] ", finish"
1792095384632 assistant [27000-27200] "Okay."
1792095386032 assistant [28400-28600] "The harbor"
1792095386033 assistant [28600-28800] " bird"
1792095386732 assistant [29000-29200] " is the"
1792095386733 assistant [29200-29400] " red-legged"
1792095386735 assistant [29800-30000] " kitt"
1792095386735 assistant [30000-30200] "iwake"
1792095386736 assistant [30200-30400] "."
1792095387435 assistant [30600-30800] " This"
1792095387437 assistant [31000-31200] " spring,"
1792095387438 assistant [31400-31600] " lighthouse"
1792095388132 assistant [32000-32200] " keeper"
1792095388133 assistant [32200-32400] " Mara"
1792095388872 assistant [32600-32800] " counted"
1792095389532 assistant [33200-33400] " seventeen"
1792095390232 assistant [33800-34000] " nests."
1792095390932 assistant [34600-34800] " Nine"
1792095390934 assistant [35000-35200] " rested"
1792095391632 assistant [35400-35600] " below"
1792095392331 assistant [35800-36000] " the"
1792095392333 assistant [36000-36200] " lantern"
1792095392333 assistant [36400-36600] " room."
1792095393032 assistant [37000-37200] " Five"
1792095393732 assistant [37600-37800] " clung"
1792095393733 assistant [37800-38000] " to"
1792095394432 assistant [38000-38200] " a narrow"
1792095394435 assistant [38400-38600] " cliff"
1792095395132 assistant [38600-38800] " ledge"
1792095395134 assistant [38800-39000] "."
1792095395134 assistant [39200-39400] " Three"
1792095395832 assistant [39600-39800] " hid"
1792095395833 assistant [39800-40000] " behind"
1792095396534 assistant [40200-40400] " the"
1792095396536 assistant [40400-40600] " old"
1792095396537 assistant [40600-40800] " fog"
1792095397232 assistant [40800-41000] " bell."
1792095397933 assistant [41400-41600] " Mara"
1792095397937 assistant [41800-42000] " marked"
1792095398632 assistant [42200-42400] " each"
1792095398633 assistant [42600-42800] " nest"
1792095399332 assistant [43000-43200] " in"
1792095399334 assistant [43200-43400] " her"
1792095399335 assistant [43400-43600] " blue"
1792095400032 assistant [43600-43800] " notebook."
SQL: SELECT job,state,session,event,updated FROM deliveries WHERE job=? [be1a487a-f441-47f7-9c36-12892e87731c]
{"job":"be1a487a-f441-47f7-9c36-12892e87731c","state":"injected","session":"live_EZM9jO23gxJmFbNYSBNp1","event":"result_ff1b2616-6b7e-465e-a722-6bbbd4ebec9f","updated":1792095385239}
SQL: SELECT id,delegation,created,substr(result,1,80) AS result FROM jobs WHERE conversation=? AND session=? [92357be8-6be7-4e03-bb66-c4e9352db2c6, live_EZM9jO23gxJmFbNYSBNp1]
[]
SQL: SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN (...) [92357be8-6be7-4e03-bb66-c4e9352db2c6]
[{"kind":"session.cut_off","payload":"{\"session\":\"live_EZM9OsB7NJ4p949wtKVDk\",\"job\":\"be1a487a-f441-47f7-9c36-12892e87731c\"}","at":1792095355609},{"kind":"result.cut_off_offered","payload":"{\"session\":\"live_EZM9jO23gxJmFbNYSBNp1\",\"at\":1792095358530}","at":1792095358534},{"kind":"delivery.consent","payload":"{\"session\":\"live_EZM9jO23gxJmFbNYSBNp1\",\"at\":1792095385130}","at":1792095385134}]
7a run 1: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 1: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":1,"rerunJobs":0,"missing":[]}
[cleanup] {"run":"fix7-mv9zagfq","testConversations":1,"hermesSessions":["voice-92357be8-6be7-4e03-bb66-c4e9352db2c6-live_EZM9OsB7NJ4p949wtKVDk"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-92357be8-6be7-4e03-bb66-c4e9352db2c6-live_EZM9OsB7NJ4p949wtKVDk":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

=== run 2: test run fix7-mv9zdcso, conversation 1c3c419a-d914-4e3f-bca0-fcbbce7c7aca, session live_EZMBZUzpv9Mc6UvAWPb5E
dropped at 1792095488151 (2005 ms into the answer); reconnected session live_EZMBt8OU9HA7CpLSEiFVL at 1792095490570
SQL: SELECT id,session,state,result,created,updated FROM jobs WHERE id=? [483b84e1-e614-4cfc-adf8-135483397b3d]
{
 "id": "483b84e1-e614-4cfc-adf8-135483397b3d",
 "session": "live_EZMBZUzpv9Mc6UvAWPb5E",
 "state": "completed",
 "result": "The harbor bird is Chatham albatross.\nThis spring, the lighthouse keeper counted 37 nests.\nHe marked each nest with a blue pebble.\nOne sheltered nest held a speckled egg.\nHe named the busiest pair Pip and Mallow.\nEach evening, he recorded his findings by lantern light.",
 "created": 1792095473293,
 "updated": 1792095485511
}
--- dropped session s1 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMBZUzpv9Mc6UvAWPb5E])
1792095473292 user      [1792095473289-1792095473289] "Automated voice test for Hermes. Choose one random uncommon sea bird species yourself. Then write six short plain sentences about a lighthouse keeper counting that bird's nests this spring, with made-up numbers and details. The first sentence must be exactly: The harbor bird is <the species>. Reply with only those six sentences, without using any tools."
1792095486814 assistant [15600-15800] "The harbor"
1792095486816 assistant [15800-16000] " bird"
1792095486816 assistant [16000-16200] " is Ch"
1792095486817 assistant [16200-16400] "atham"
1792095487516 assistant [16400-16600] " albat"
1792095487520 assistant [16600-16800] "ross."
1792095488214 assistant [17400-17600] " This"
1792095488215 assistant [17600-17800] " spring,"
--- reconnected session s2 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMBt8OU9HA7CpLSEiFVL])
1792095493139 assistant [1800-2000] " We got"
1792095493142 assistant [2000-2200] " cut off"
1792095493143 assistant [2200-2400] "."
1792095493815 assistant [2600-2800] " Want"
1792095493818 assistant [2800-3000] " me"
1792095494514 assistant [3000-3200] " to finish"
1792095494516 assistant [3200-3400] " what"
1792095494517 assistant [3400-3600] " I was"
1792095494518 assistant [3600-3800] " saying?"
1792095517614 user      [26200-26400] " Yes"
1792095517616 user      [26600-26800] ", finish"
1792095518315 assistant [27400-27600] " Okay."
1792095519715 assistant [29600-29800] " The harbor"
1792095519716 assistant [29800-30000] " bird"
1792095519717 assistant [30200-30400] " is Ch"
1792095520415 assistant [30400-30600] "atham"
1792095520417 assistant [30600-30800] " albat"
1792095520418 assistant [30800-31000] "ross."
1792095521115 assistant [31600-31800] " This"
1792095521816 assistant [32000-32200] " spring,"
1792095522514 assistant [32400-32600] " the lighthouse"
1792095522520 assistant [32800-33000] " keeper"
1792095523214 assistant [33200-33400] " counted"
1792095523217 assistant [33600-33800] " 37"
1792095523914 assistant [34200-34400] " nests."
1792095524617 assistant [35000-35200] " He"
1792095525316 assistant [35200-35400] " marked"
1792095525318 assistant [35600-35800] " each"
1792095525319 assistant [35800-36000] " nest"
1792095526014 assistant [36200-36400] " with"
1792095526016 assistant [36400-36600] " a blue"
1792095526715 assistant [36600-36800] " pebble"
1792095526716 assistant [36800-37000] "."
1792095527414 assistant [37400-37600] " One"
1792095528115 assistant [38000-38200] " sheltered"
1792095528118 assistant [38400-38600] " nest"
1792095528118 assistant [38600-38800] " held"
1792095528814 assistant [39000-39200] " a spe"
1792095528816 assistant [39200-39400] "ckled"
1792095529515 assistant [39400-39600] " egg."
1792095529518 assistant [39800-40000] " He"
1792095529519 assistant [40000-40200] " named"
1792095530214 assistant [40400-40600] " the busiest"
1792095530914 assistant [41000-41200] " pair"
1792095530915 assistant [41200-41400] " Pip"
1792095530916 assistant [41400-41600] " and"
1792095531614 assistant [41600-41800] " Mallow"
1792095531616 assistant [41800-42000] "."
1792095532314 assistant [42200-42400] " Each"
1792095532319 assistant [42600-42800] " evening,"
1792095533014 assistant [43200-43400] " he"
1792095533015 assistant [43400-43600] " recorded"
1792095533715 assistant [43800-44000] " his"
1792095533717 assistant [44000-44200] " findings"
1792095534415 assistant [44400-44600] " by"
1792095534417 assistant [44600-44800] " lantern"
1792095534418 assistant [44800-45000] " light."
SQL: SELECT job,state,session,event,updated FROM deliveries WHERE job=? [483b84e1-e614-4cfc-adf8-135483397b3d]
{"job":"483b84e1-e614-4cfc-adf8-135483397b3d","state":"injected","session":"live_EZMBt8OU9HA7CpLSEiFVL","event":"result_01f3e505-e4f6-46f3-82a2-8eac91764c8a","updated":1792095518707}
SQL: SELECT id,delegation,created,substr(result,1,80) AS result FROM jobs WHERE conversation=? AND session=? [1c3c419a-d914-4e3f-bca0-fcbbce7c7aca, live_EZMBt8OU9HA7CpLSEiFVL]
[]
SQL: SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN (...) [1c3c419a-d914-4e3f-bca0-fcbbce7c7aca]
[{"kind":"session.cut_off","payload":"{\"session\":\"live_EZMBZUzpv9Mc6UvAWPb5E\",\"job\":\"483b84e1-e614-4cfc-adf8-135483397b3d\"}","at":1792095489307},{"kind":"result.cut_off_offered","payload":"{\"session\":\"live_EZMBt8OU9HA7CpLSEiFVL\",\"at\":1792095492213}","at":1792095492219},{"kind":"delivery.consent","payload":"{\"session\":\"live_EZMBt8OU9HA7CpLSEiFVL\",\"at\":1792095518613}","at":1792095518615}]
7a run 2: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 2: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":1,"rerunJobs":0,"missing":[]}
[cleanup] {"run":"fix7-mv9zdcso","testConversations":1,"hermesSessions":["voice-1c3c419a-d914-4e3f-bca0-fcbbce7c7aca-live_EZMBZUzpv9Mc6UvAWPb5E"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-1c3c419a-d914-4e3f-bca0-fcbbce7c7aca-live_EZMBZUzpv9Mc6UvAWPb5E":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

=== run 3: test run fix7-mv9zg8af, conversation 60a589fb-7d4f-481b-a169-eb94506c3604, session live_EZMDjkscSyW3ReSSSgqha
dropped at 1792095618613 (2005 ms into the answer); reconnected session live_EZME0krC3M3OJzcPqFStC at 1792095621095
SQL: SELECT id,session,state,result,created,updated FROM jobs WHERE id=? [48e5d6a4-0fb0-491e-8e07-d031af8cc85d]
{
 "id": "48e5d6a4-0fb0-491e-8e07-d031af8cc85d",
 "session": "live_EZMDjkscSyW3ReSSSgqha",
 "state": "completed",
 "result": "The harbor bird is red-legged kittiwake.\nThe lighthouse keeper counted seventeen nests this spring.\nNine nests rested beside the old fog bell.\nHe marked each nest on a blue paper chart.\nOne nest held a shiny brass button.\nHe finished counting before the evening rain.",
 "created": 1792095607410,
 "updated": 1792095616067
}
--- dropped session s1 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMDjkscSyW3ReSSSgqha])
1792095607406 user      [1792095607402-1792095607402] "Automated voice test for Hermes. Choose one random uncommon sea bird species yourself. Then write six short plain sentences about a lighthouse keeper counting that bird's nests this spring, with made-up numbers and details. The first sentence must be exactly: The harbor bird is <the species>. Reply with only those six sentences, without using any tools."
1792095608283 assistant [3400-3600] "Okay."
1792095608980 assistant [4200-4400] " I"
1792095609682 assistant [4400-4600] " see"
1792095609686 assistant [4600-4800] " that test"
1792095609688 assistant [5000-5200] " request."
1792095610379 assistant [5400-5600] " Hermes"
1792095611078 assistant [5800-6000] " is on"
1792095611079 assistant [6000-6200] " it."
1792095616679 assistant [12000-12200] " The harbor"
1792095617379 assistant [12200-12400] " bird"
1792095617381 assistant [12400-12600] " is"
1792095618078 assistant [12600-12800] " red-legged"
1792095618082 assistant [13000-13200] " kitt"
1792095618082 assistant [13200-13400] "iwake"
1792095618084 assistant [13400-13600] "."
1792095618778 assistant [13800-14000] " The lighthouse"
--- reconnected session s2 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZME0krC3M3OJzcPqFStC])
1792095623678 assistant [1800-2000] "We got"
1792095623680 assistant [2000-2200] " cut off"
1792095623680 assistant [2200-2400] ". Want"
1792095624378 assistant [2400-2600] " me"
1792095624380 assistant [2600-2800] " to finish"
1792095624381 assistant [3000-3200] " what I"
1792095625078 assistant [3200-3400] " was saying"
1792095625080 assistant [3400-3600] "?"
1792095647478 user      [26000-26200] " Yes"
1792095648178 user      [26800-27000] ", finish"
1792095649578 assistant [27800-28000] "Okay."
1792095650279 assistant [30000-30200] "The harbor"
1792095650280 assistant [30200-30400] " bird"
1792095650978 assistant [30400-30600] " is"
1792095650980 assistant [30600-30800] " red-legged"
1792095651678 assistant [31000-31200] " kitt"
1792095651680 assistant [31200-31400] "iwake"
1792095651681 assistant [31400-31600] "."
1792095652379 assistant [31800-32000] " The"
1792095652383 assistant [32000-32200] " lighthouse"
1792095653079 assistant [32400-32600] " keeper"
1792095653081 assistant [32800-33000] " counted"
1792095653082 assistant [33000-33200] " seventeen"
1792095653779 assistant [33400-33600] " nests"
1792095653781 assistant [33800-34000] " this"
1792095654478 assistant [34000-34200] " spring."
1792095655191 assistant [34600-34800] " Nine"
1792095655204 assistant [35000-35200] " nests"
1792095655878 assistant [35400-35600] " rested"
1792095655886 assistant [35800-36000] " beside"
1792095656580 assistant [36200-36400] " the old"
1792095656590 assistant [36600-36800] " fog"
1792095657281 assistant [36800-37000] " bell."
1792095657978 assistant [37400-37600] " He"
1792095657981 assistant [37600-37800] " marked"
1792095658678 assistant [38000-38200] " each"
1792095658680 assistant [38200-38400] " nest"
1792095658681 assistant [38600-38800] " on a"
1792095659378 assistant [38800-39000] " blue"
1792095659380 assistant [39000-39200] " paper"
1792095659380 assistant [39200-39400] " chart."
1792095660782 assistant [40200-40400] " One nest"
1792095660786 assistant [40400-40600] " held"
1792095660788 assistant [40800-41000] " a shiny"
1792095661480 assistant [41200-41400] " brass"
1792095661481 assistant [41400-41600] " button."
1792095662178 assistant [42000-42200] " He finished"
1792095662878 assistant [42400-42600] " counting"
1792095662880 assistant [42800-43000] " before"
1792095663578 assistant [43200-43400] " the"
1792095663579 assistant [43400-43600] " evening"
1792095663580 assistant [43600-43800] " rain."
SQL: SELECT job,state,session,event,updated FROM deliveries WHERE job=? [48e5d6a4-0fb0-491e-8e07-d031af8cc85d]
{"job":"48e5d6a4-0fb0-491e-8e07-d031af8cc85d","state":"injected","session":"live_EZME0krC3M3OJzcPqFStC","event":"result_3780d69f-3fcb-4077-bde5-c2bc9deb2d71","updated":1792095649587}
SQL: SELECT id,delegation,created,substr(result,1,80) AS result FROM jobs WHERE conversation=? AND session=? [60a589fb-7d4f-481b-a169-eb94506c3604, live_EZME0krC3M3OJzcPqFStC]
[]
SQL: SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN (...) [60a589fb-7d4f-481b-a169-eb94506c3604]
[{"kind":"session.cut_off","payload":"{\"session\":\"live_EZMDjkscSyW3ReSSSgqha\",\"job\":\"48e5d6a4-0fb0-491e-8e07-d031af8cc85d\"}","at":1792095619763},{"kind":"result.cut_off_offered","payload":"{\"session\":\"live_EZME0krC3M3OJzcPqFStC\",\"at\":1792095622676}","at":1792095622683},{"kind":"delivery.consent","payload":"{\"session\":\"live_EZME0krC3M3OJzcPqFStC\",\"at\":1792095649476}","at":1792095649480}]
7a run 3: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 3: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":1,"repeats":1,"rerunJobs":0,"missing":[]}
[cleanup] {"run":"fix7-mv9zg8af","testConversations":1,"hermesSessions":["voice-60a589fb-7d4f-481b-a169-eb94506c3604-live_EZMDjkscSyW3ReSSSgqha"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-60a589fb-7d4f-481b-a169-eb94506c3604-live_EZMDjkscSyW3ReSSSgqha":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

SUMMARY 7a 3/3 PASS, 7b 3/3 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792095671145.json
exit=0
```

App records showing the handoff guard fired in each final run (`node -e` read-only query on `audit`):

```
SELECT kind,at FROM audit WHERE conversation=? AND (kind LIKE 'delegation%' OR kind LIKE 'session.cut%' OR kind LIKE 'result.cut%' OR kind='delivery.consent') ORDER BY at
92357be8-6be7-4e03-bb66-c4e9352db2c6 [{"kind":"session.cut_off","at":1792095355609},{"kind":"result.cut_off_offered","at":1792095358534},{"kind":"delegation.cut_off_reply","at":1792095384134},{"kind":"delivery.consent","at":1792095385134}]
1c3c419a-d914-4e3f-bca0-fcbbce7c7aca [{"kind":"session.cut_off","at":1792095489307},{"kind":"result.cut_off_offered","at":1792095492219},{"kind":"delegation.cut_off_reply","at":1792095518059},{"kind":"delivery.consent","at":1792095518615}]
60a589fb-7d4f-481b-a169-eb94506c3604 [{"kind":"session.cut_off","at":1792095619763},{"kind":"result.cut_off_offered","at":1792095622683},{"kind":"delegation.cut_off_reply","at":1792095649011},{"kind":"delivery.consent","at":1792095649480}]
```

### 7a: PASS (3/3)
In all three runs, the first assistant fragment of the reconnected session is the single line "We got cut off. Want me to finish what I was saying?" (`offerOnly: true`, `turns: 1`). No word of the cut-off answer was spoken before the user's yes (`resumed: []`).

### 7b: PASS (3/3)
In all three runs, after "Yes, finish" the voice said "Okay." (1 word) and then the complete job result once:
- coverage 1.0, with the Hermes-chosen species;
- `repeats: 1` and `rerunJobs: 0`;
- `deliveries` row `injected` in the reconnected session, updated after the yes fragment.

## 7c: Fix 1 still holds, rerun of 1a and 1c: PASS

Command: `node scripts/live-e2e/fix1.mjs` on build `3a0ab18ca1e6c5ea` (`logs/live-e2e/fix7-7c-fix1.log`, complete raw output):

```
{"timestamp":"2026-10-15T20:22:19.314Z","level":"info","logger":"live-e2e.fix1","message":"job A finished","state":"completed"}
{"timestamp":"2026-10-15T20:22:19.314Z","level":"info","logger":"live-e2e.fix1","message":"waiting 5 minutes before the next call","until":"2026-10-15T20:27:19.314Z"}
{"timestamp":"2026-10-15T20:28:21.851Z","level":"info","logger":"live-e2e.fix1","message":"check 1a: PASS","note":"deliveries for earlier-call jobs=0; assistant turns in first 60 s=1; waiting lines=1"}

=== 1a PASS deliveries for earlier-call jobs=0; assistant turns in first 60 s=1; waiting lines=1
SQL: SELECT d.job,d.state,d.session,d.updated,j.session AS job_session FROM deliveries d JOIN jobs j ON j.id=d.job WHERE d.session=? AND j.session<>?
ARGS: ["live_EZMKmm72YUD3BwBGiDCZi","live_EZMKmm72YUD3BwBGiDCZi"]
ROWS: []
{"timestamp":"2026-10-15T20:28:38.757Z","level":"info","logger":"live-e2e.fix1","message":"check 1b: PASS","note":"job A key word \"the violet-backed hyliota\"; assistant after yes: \"Okay. The test bird is the violet-backed hyliota. It was seen at the east pond. The test bird is the violet-backed hyliota. It was seen at the east pond.\""}

=== 1b PASS job A key word "the violet-backed hyliota"; assistant after yes: "Okay. The test bird is the violet-backed hyliota. It was seen at the east pond. The test bird is the violet-backed hyliota. It was seen at the east pond."
SQL: SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments f WHERE f.session=? AND f.role='user' AND f.at>=?) AS yes_fragment_at FROM deliveries d WHERE d.job=?
ARGS: ["live_EZMKmm72YUD3BwBGiDCZi",1792096041846,"af18c3aa-4ecc-4b30-bb7f-41901907c821"]
ROWS: [
 {
  "job": "af18c3aa-4ecc-4b30-bb7f-41901907c821",
  "state": "injected",
  "session": "live_EZMKmm72YUD3BwBGiDCZi",
  "updated": 1792096106291,
  "yes_fragment_at": 1792096103301
 }
]
{"timestamp":"2026-10-15T20:29:32.151Z","level":"info","logger":"live-e2e.fix1","message":"check 1c: PASS","note":"stop fragment start_ms=20200; assistant fragments starting >1 s after stop=0 (received in 30 s, incl. tail=2); new deliveries in 30 s=0; second result final and waiting=true"}

=== 1c PASS stop fragment start_ms=20200; assistant fragments starting >1 s after stop=0 (received in 30 s, incl. tail=2); new deliveries in 30 s=0; second result final and waiting=true
SQL: SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND start_ms>?+1000 AND start_ms<=?+31000;
SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<=?;
SELECT job,state,session,updated FROM deliveries WHERE session=? AND updated>? AND updated<=?;
SELECT id,state,updated FROM jobs WHERE id IN (?,?)
ARGS: ["live_EZMM5oOtikPpNrpqaICLr",20200,1792096142064,1792096172064,"bf746889-44ce-47e8-84b5-07cfbffe6a73","3a92affc-fa20-4008-a710-28df21d4a67d"]
ROWS: {
 "assistant": [],
 "received": [
  {
   "role": "assistant",
   "text": " is",
   "at": 1792096142066,
   "start_ms": 20400,
   "end_ms": 20600
  },
  {
   "role": "assistant",
   "text": " painted",
   "at": 1792096142759,
   "start_ms": 20600,
   "end_ms": 20800
  }
 ],
 "deliveries": [],
 "waiting": [
  {
   "id": "3a92affc-fa20-4008-a710-28df21d4a67d",
   "state": "completed",
   "updated": 1792096134769
  },
  {
   "id": "bf746889-44ce-47e8-84b5-07cfbffe6a73",
   "state": "completed",
   "updated": 1792096132073
  }
 ]
}
{"timestamp":"2026-10-15T20:30:00.519Z","level":"info","logger":"live-e2e.fix1","message":"check 1d: PASS","note":"question fragment at 1792096173558"}

=== 1d PASS question fragment at 1792096173558
SQL: SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments WHERE session=? AND role='assistant' AND at>?) AS answer_at,(SELECT group_concat(text,'') FROM (SELECT text FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<d.updated ORDER BY at,rowid)) AS answer_text FROM deliveries d WHERE d.job=?
ARGS: ["live_EZMM5oOtikPpNrpqaICLr",1792096173558,"live_EZMM5oOtikPpNrpqaICLr",1792096173558,"3a92affc-fa20-4008-a710-28df21d4a67d"]
ROWS: [
 {
  "job": "3a92affc-fa20-4008-a710-28df21d4a67d",
  "state": "injected",
  "session": "live_EZMM5oOtikPpNrpqaICLr",
  "updated": 1792096185147,
  "answer_at": 1792096173562,
  "answer_text": " What's the cap Paris."
 }
]
{"timestamp":"2026-10-15T20:30:02.619Z","level":"info","logger":"live-e2e.fix1","message":"check 1e: PASS","note":""}

=== 1e PASS 
SQL: SELECT COUNT(*) AS n FROM jobs j LEFT JOIN deliveries d ON d.job=j.id WHERE j.state IN ('completed','failed','cancelled','interrupted') AND j.updated<? AND (d.state IS NULL OR d.state='available')
ARGS: [1791529200000]
ROWS: [
 {
  "n": 0
 }
]
{"timestamp":"2026-10-15T20:30:02.659Z","level":"info","logger":"live-e2e.fix1","message":"check 1f: PASS","note":"overlapping user fragments=4"}

=== 1f PASS overlapping user fragments=4
SQL: SELECT u.session,u.text,u.at,u.start_ms,u.end_ms,d.job,d.state,d.updated FROM fragments u JOIN deliveries d ON d.session=u.session AND d.updated>=u.at AND d.updated<u.at+10000 WHERE u.role='user' AND u.session IN (?,?,?) AND EXISTS (SELECT 1 FROM fragments a WHERE a.session=u.session AND a.role='assistant' AND a.start_ms<u.end_ms AND a.end_ms>u.start_ms)
ARGS: ["live_EZMFiaUIbxPhqqylX8Qtb","live_EZMKmm72YUD3BwBGiDCZi","live_EZMM5oOtikPpNrpqaICLr"]
ROWS: []

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix1-1792096202659.json
[cleanup] {"run":"fix1-mv9zivrn","testConversations":1,"hermesSessions":["voice-ac3c95b5-9f80-4906-a6b5-0d9b0804bac3-live_EZMFiaUIbxPhqqylX8Qtb","voice-ac3c95b5-9f80-4906-a6b5-0d9b0804bac3-live_EZMKmm72YUD3BwBGiDCZi","voice-ac3c95b5-9f80-4906-a6b5-0d9b0804bac3-live_EZMM5oOtikPpNrpqaICLr"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":1,"bySource":{"hermes-session":1},"invalidated":1,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-ac3c95b5-9f80-4906-a6b5-0d9b0804bac3-live_EZMFiaUIbxPhqqylX8Qtb":0,"voice-ac3c95b5-9f80-4906-a6b5-0d9b0804bac3-live_EZMKmm72YUD3BwBGiDCZi":0,"voice-ac3c95b5-9f80-4906-a6b5-0d9b0804bac3-live_EZMM5oOtikPpNrpqaICLr":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
exit=0
```

1a PASS and 1c PASS (and 1b, 1d, 1e and 1f PASS). In 1b the voice said job A's result twice ("The test bird is the violet-backed hyliota…" ×2). The Oct 9 Fix 1 evidence shows the same shape, a made-up bird and then the real one (`docs/evidence/fix1.md` line 76). The Fix 1 waiting-results path predates Fix 7, and Fix 7 does not change it. Recorded here, not fixed (out of scope for Fix 7).

## Isolation

Every run printed `[isolation] owner conversation new fragments: 0` (above). Direct check after all runs:

```
$ node -e '…readOnly…; owner = cache[default-conversation]; SELECT COUNT(*) AS n, MAX(at) AS last_at FROM fragments WHERE conversation=? AND at>=1792092600000'
owner conversation: ccad5a2f-2433-4361-bfc8-bba14d7973e9
{"n":0,"last_at":null}
```

The 19 test conversations used (`conversations.test`): fix7-mv9xqo77 … fix7-mv9zg8af (18 Fix 7 runs) and fix1-mv9zivrn (7c). Every run ran `cleanup.mjs`: each of the 7 run logs under `logs/live-e2e/` (git-ignored) has one `[cleanup]` line and one `[isolation] owner conversation new fragments: 0` line per run (counted with `grep -c`: baseline 3/3, baseline2 3/3, after 3/3, after2 3/3, after3 3/3, after4 3/3, 7c 1/1).

## Limits

- The drop is simulated by closing the page's peer connection. It runs the app's real reconnect path, but it is not a radio or network loss on a phone.
- The cut-off test uses a typed background task, as the Fix 1 harness does. The model's own spoken answers that get cut off use the same marking and the "finish" path. That path is covered by code tests, not by a live run.
- One live observation (iteration 2, run 1): the Azure voice stream stalled mid-result. That was not reproduced in later runs.
