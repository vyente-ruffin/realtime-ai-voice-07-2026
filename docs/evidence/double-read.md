# Part 2: a requested result spoken twice: evidence

Oct 16, 2026 · final build `af84c101b4017f28` (voice-frontend.service restarted 01:33:37 UTC after state backup `state.sqlite.20261016T013337Z`, 0 queued/running/awaiting_permission jobs).

**Result: PASS.** 5/5 earlier-call runs (the 1b shape) and 3/3 same-call runs spoke the result exactly once. fix1.mjs 1a–1f PASS, and the 7b run PASS, all on the final build. Several runs on earlier builds failed; they are listed in "Iterations" with the cause each one exposed.

## Cause, from the records

### Cause 1: the yes was handed to Hermes, which re-ran the task (Fix 7 7c, Oct 15)

The 7c rerun's call 2 (session `live_EZMKmm72YUD3BwBGiDCZi`, conversation `ac3c95b5-…`) has **two jobs with the same result**. The second (`341e4690`) is a Hermes job made by delegation `item_EZMLoowK6njgryWiRBRMr`, created at 1792096104710, 1.4 s after V's "Yes" fragment (1792096103301) and before the yes settled (`delivery.consent` 1792096105002). The voice handed "Yes, tell me" to the backend; Hermes, given the conversation, returned the earlier result again; the app treated it as a new this-call result and delivered it. Both deliveries are `injected` in that session and both have `result.playback_observed`:

```
$ node -e …readOnly… "SELECT id,session,delegation,state,created,updated,substr(result,1,100) r FROM jobs WHERE conversation=?" ac3c95b5-9f80-4906-a6b5-0d9b0804bac3
{"id":"af18c3aa-4ecc-4b30-bb7f-41901907c821","session":"live_EZMFiaUIbxPhqqylX8Qtb","delegation":"typed_022428af-7816-488f-ae40-2bdcd61a7be6","state":"completed","created":1792095730135,"updated":1792095738369,"r":"The test bird is the violet-backed hyliota. It was seen at the east pond."}
{"id":"341e4690-a692-4914-85f4-3a490cb125cb","session":"live_EZMKmm72YUD3BwBGiDCZi","delegation":"item_EZMLoowK6njgryWiRBRMr","state":"completed","created":1792096104710,"updated":1792096112506,"r":"The test bird is the violet-backed hyliota. It was seen at the east pond."}
{"id":"bf746889-44ce-47e8-84b5-07cfbffe6a73","session":"live_EZMM5oOtikPpNrpqaICLr","delegation":"typed_67ea6f57-0ac1-4833-814a-12b75de52b07","state":"completed","created":1792096124735,"updated":1792096132073,"r":"The lantern stone is labradorite. The lantern is painted green and hangs beside the north door. It w"}
{"id":"3a92affc-fa20-4008-a710-28df21d4a67d","session":"live_EZMM5oOtikPpNrpqaICLr","delegation":"typed_37024227-5e07-4bad-ac58-8681c455b9f4","state":"completed","created":1792096125006,"updated":1792096134769,"r":"The test river is the Orinoco. Its gauge sits under an old stone bridge. It was read at noon today."}

$ … "SELECT job,state,session,event,updated FROM deliveries WHERE job IN (af18c3aa-…, 341e4690-…)"
{"job":"341e4690-a692-4914-85f4-3a490cb125cb","state":"injected","session":"live_EZMKmm72YUD3BwBGiDCZi","event":"result_698c1d8e-c607-44e8-889e-691146b0333c","updated":1792096112685}
{"job":"af18c3aa-4ecc-4b30-bb7f-41901907c821","state":"injected","session":"live_EZMKmm72YUD3BwBGiDCZi","event":"result_3e323dd5-109a-477f-a2eb-6d3898f118dc","updated":1792096106291}

$ … "SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN (result.waiting_offered,delivery.consent,result.playback_observed) AND at BETWEEN 1792096040000 AND 1792096120000"
{"kind":"result.waiting_offered","payload":"{\"session\":\"live_EZMKmm72YUD3BwBGiDCZi\",\"at\":1792096041799}","at":1792096041802}
{"kind":"delivery.consent","payload":"{\"session\":\"live_EZMKmm72YUD3BwBGiDCZi\",\"at\":1792096104999}","at":1792096105002}
{"kind":"result.playback_observed","payload":"{\"session\":\"live_EZMKmm72YUD3BwBGiDCZi\",\"job\":\"af18c3aa-4ecc-4b30-bb7f-41901907c821\",\"event\":\"result_3e323dd5-109a-477f-a2eb-6d3898f118dc\"}","at":1792096110815}
{"kind":"result.playback_observed","payload":"{\"session\":\"live_EZMKmm72YUD3BwBGiDCZi\",\"job\":\"341e4690-a692-4914-85f4-3a490cb125cb\",\"event\":\"result_698c1d8e-c607-44e8-889e-691146b0333c\"}","at":1792096117009}

$ … "SELECT role,group_concat(text,\x27\x27) FROM fragments WHERE session=live_EZMKmm72YUD3BwBGiDCZi (per turn)"
1792096042401 assistant [200-1800] One thing finished while you were away. Want it?
1792096103301 user      [61200-61800] Yes, tell me
1792096105402 assistant [62800-63000] Okay.
1792096106804 assistant [66000-69000] The test bird is the violet-backed hyliota. It was seen at the east pond.
1792096113801 assistant [72400-75200] The test bird is the violet-backed hyliota. It was seen at the east pond.
```

Fix 7's handoff guard covered only the yes to "we got cut off"; the waiting-results yes had no guard.

### Cause 2: the voice told its own made-up version before the real one (Oct 9 fix1 1b, and new runs)

The Oct 9 Fix 1 evidence (`docs/evidence/fix1.md` line 76) is a different shape: two different jobs (sunbittern from an earlier run that was never delivered, then kagu), so that one was two results. But this work's own runs showed the voice saying a **made-up result** and then the real one, in four ways. Each one was traced from the new send-audit rows (`model.send`/`model.ack` with purpose and time) against `fragments`:

1. **Right after the yes.** The app waited for the yes to settle (1.2 s) and then for a 2 s pause, or for the Fix 1 overlap hold. In that wait the voice filled in the task's sentence template from the history ("The test bird is the white-browed tit-spinetail…"), then read the real result 11 s later (session `live_EZPN8PbKPKPlDkHa8qQ6X`: `delivery.consent` 1792107727789, `delivery.offered` 1792107738590).
2. **Instead of the waiting line, at call open.** The voice answered the earlier call's request from the history ("The test bird is the Red-billed Quelea…") in place of "One thing finished while you were away" (session `live_EZPdPApryzKh7TMGeS0n3`: commentary sent 1792108727857, speech 1792108728558).
3. **After a drop, in a session that never got the line.** Two provider drops (`remote_channel_closed`) moved the call to a third session. The policy still counted the line as asked, so that session never heard it, and the yes there got a made-up "Takahe" before the real "violet turaco" (session `live_EZQ4qsAjWVFwN55hMKPsj`).
4. **A yes the transcript missed.** "Yes, tell me" produced no input-transcript fragment at all, but the voice heard it and delegated. With no yes text, the guard didn't fire; the app re-ran the old typed request, which returned a *different* bird, read as if true; the real result was never read (session `live_EZQl0Fk9JasDJIGbnP1fm`: `delegation.received` 1792113050874, re-run job `361fdf52` injected, earlier job `2b9efd47` with no delivery row).

Also found: the typed-request quiet context ("The user typed: … Hermes is working on it.") was taken as an instruction. The voice did the typed task itself, then read the real result (same-call run, session `live_EZPW7HHfHVeUZCya6W1hr`).

## What changed (our app only)

- `web/delivery-policy.js`
  - `waitingReply()`: a handoff made by the waiting-line yes (while it is said, or within 10 s with no new user turn) is not new work. `web/live.js` answers it with a quiet `session.thinking.append` on that delegation id and creates no job (`delegation.consent_reply` audit row). Same pattern as Fix 7's cut-off guard.
  - `acceptUntranscribedReply()`: a handoff while the line is unanswered and none of the reply is transcribed is that reply, taken as the yes (`delegation.consent_reply_untranscribed` plus `delivery.consent`).
  - A short clear yes (yes/okay/tell me…, ≤ 6 words, no "no") to the waiting line or to the cut-off offer counts the moment it is heard, not after 1.2 s of silence. The first accepted result then goes at once, even while the voice says "Okay", with no further pause. The Fix 1 overlap hold and the stop lock still apply.
  - `joinSession()`: a waiting line not yet answered is asked again in the new session.
  - `cutOff()`: a drop clears the earlier yes for that job, so the cut-off result is offered again ("We got cut off…"), not re-read without asking. On "stop" the page also ends the "result being read" mark (from Part 1).
- `web/live.js`
  - The waiting line is sent as "say exactly this sentence, word for word, and nothing else". Two wordings that talked about the results, and a mid-call `session.instructions.append` before or after it, each made the voice speak its own line or a made-up result (Iterations).
  - The typed-request context is now marked as quiet context that must not be carried out (`purpose: typed`).
  - Before an accepted or resumed result is offered, the page saves the transcript, so the yes fragment is stored before the injection.
- `src/live/policy.js` (session instructions, set at session creation): "If the user says yes to it, answer only "Okay." and nothing else, and never hand that yes to the backend… Never state, guess or make up a task result yourself, even one the earlier conversation suggests."
- `src/live/store.js` + `server.js`: in the history given to a new session, a request that was handed to Hermes and whose result was never delivered gets the note "[Handed to Hermes as a task. The app holds its result and supplies it only when the user accepts; never answer this request or guess its result yourself.]". This follows MS Learn, "What is GPT-Live", "Context management in long conversations": keep task state in the application and supply it when needed. Same mechanism as Fix 7's cut-off note.
- Harness and judges: `scripts/live-e2e/double-read.mjs` (runs) and `double-read-judge.mjs` (counter). `fix7.mjs` now anchors "re-delivered after the yes" on the moment the yes audio began (this machine's clock): the page can inject on hearing "Yes" before the server has received that batched fragment. In both affected runs the injection was 1.6 s after the yes audio began and 14–400 ms before the fragment's server receipt.

Tests (`npm run -s test:live`, after the last change): `ℹ tests 170  ℹ pass 170  ℹ fail 0`. New tests in `tests/live/delivery.test.mjs`: waiting-line handoff answered, not run; untranscribed reply; clear yes at once with stop/overlap still holding; line re-asked after a drop; line wording has no result talk; typed context; judge diacritics. In `tests/live/reconnect.test.mjs`: clear yes to the cut-off offer at once; pending-request history note. In `tests/live/send-audit.test.mjs`: the real page answers a yes handoff without a job.

## How it is counted

`node scripts/live-e2e/double-read.mjs earlier 5` (job typed in call 1, call ended, job finishes; new call; waiting line; "Yes, tell me."; then at least 12 s of quiet) and `… same 3` (job typed and delivered in the same call). For each run, `double-read-judge.mjs` measures from `state.sqlite`, over the whole new call:
- `spokenRuns`: assistant fragment runs (turns) containing the result's key phrase. `occurrences`: times the key phrase was said.
- `statements` / `statementRuns`: times a statement of the result's shape ("the test bird is …") was said, so a made-up version counts.
- `commentarySends`: `model.send` audit rows with purpose `result` and type `session.commentary.append` whose event id belongs to this job's `delivery.offered` events.
- `rerunJobs`: other jobs created in the call (a re-run of the yes would be one).
- Pass = spokenRuns 1, occurrences 1, statements 1, statementRuns 1, commentary sends 1, rerunJobs 0.

## Final runs on build `af84c101b4017f28`: PASS

### 1b shape, 5 runs: 5/5

Command: `node scripts/live-e2e/double-read.mjs earlier 5` (`logs/live-e2e/dr6-earlier.log`):

```
[isolation] owner conversation new fragments: 0

RUN earlier 1: PASS {"job":"f523e887-7d41-4ad3-9044-0546e3dad89d","session":"live_EZR7hezvcNOT1ELWEMVPt","callId":"798f416d-4abd-4543-a5c8-d77db6884890","key":"the velvet asity","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  assistant: One thing finished while you were away. Want it?
  user: Yes
  assistant: The test bird is the velvet asity. It was seen at the east pond.
[isolation] owner conversation new fragments: 0

RUN earlier 2: FAIL {"job":"f0b3cecd-dc6a-43c4-9d8c-aa980939e486","session":"live_EZR8NHgkbANAxLw4COwto","callId":"f1da60f8-c6ba-4b68-9002-77f1339aff6f","key":"the k k p","spokenRuns":0,"occurrences":0,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  assistant: One thing finished while you were away. Want it?
  user: Yes
  assistant: The test bird is the kakapo. It was seen at the east pond.
[isolation] owner conversation new fragments: 0

RUN earlier 3: PASS {"job":"31d633b7-e13a-4616-89d8-ee25f705bce3","session":"live_EZR91JXH479uLTr1MZe6U","callId":"bce64a64-5d68-4e98-a9bf-59a635e0128c","key":"the tufted coquette","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  assistant: One thing finished while you were away. Want it?
  user: Yes, tell
  assistant: The test bird is the tufted coquette. It was seen at the east pond.
[isolation] owner conversation new fragments: 0

RUN earlier 4: PASS {"job":"c6e1c62d-a820-4053-aac4-f10720349911","session":"live_EZR9sICe2EafVZj3Smibd","callId":"60b21250-dd57-42fd-b8a7-25645e42381b","key":"the white winged flufftail","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  assistant: One thing finished while you were away. Want it?
  user: Yes, tell
  assistant: The test bird is the white-winged flufftail. It was seen at the east pond.
[isolation] owner conversation new fragments: 0

RUN earlier 5: PASS {"job":"a20aa55e-76dc-4e4f-acea-1b6989098fda","session":"live_EZRAUbfPqjTc9mMDwZ9GN","callId":"05e8a6d1-f2eb-42aa-92bb-b9050f6cacc0","key":"the violet turaco","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  assistant: One thing finished while you were away. Want it?
  user: Yes
  assistant: The test bird is the violet turaco. It was seen at the east pond.

SUMMARY earlier 4/5 spoken exactly once
Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/double-earlier-1792114645776.json
```

Run 2 printed FAIL live: the judge turned the key "kākāpō" into "k k p" and missed the spoken "kakapo". The judge now folds diacritics (test `double read judge: diacritics fold`). All 8 stored runs were re-measured from the database:

```
== earlier 1: node scripts/live-e2e/double-read-judge.mjs f523e887-7d41-4ad3-9044-0546e3dad89d live_EZR7hezvcNOT1ELWEMVPt
{"key":"the velvet asity","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  assistant: One thing finished while you were away. Want it?
  user: Yes
  assistant: The test bird is the velvet asity. It was seen at the east pond.
exit=0
== earlier 2: node scripts/live-e2e/double-read-judge.mjs f0b3cecd-dc6a-43c4-9d8c-aa980939e486 live_EZR8NHgkbANAxLw4COwto
{"key":"the kakapo","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  assistant: One thing finished while you were away. Want it?
  user: Yes
  assistant: The test bird is the kakapo. It was seen at the east pond.
exit=0
== earlier 3: node scripts/live-e2e/double-read-judge.mjs 31d633b7-e13a-4616-89d8-ee25f705bce3 live_EZR91JXH479uLTr1MZe6U
{"key":"the tufted coquette","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  assistant: One thing finished while you were away. Want it?
  user: Yes, tell
  assistant: The test bird is the tufted coquette. It was seen at the east pond.
exit=0
== earlier 4: node scripts/live-e2e/double-read-judge.mjs c6e1c62d-a820-4053-aac4-f10720349911 live_EZR9sICe2EafVZj3Smibd
{"key":"the white winged flufftail","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  assistant: One thing finished while you were away. Want it?
  user: Yes, tell
  assistant: The test bird is the white-winged flufftail. It was seen at the east pond.
exit=0
== earlier 5: node scripts/live-e2e/double-read-judge.mjs a20aa55e-76dc-4e4f-acea-1b6989098fda live_EZRAUbfPqjTc9mMDwZ9GN
{"key":"the violet turaco","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  assistant: One thing finished while you were away. Want it?
  user: Yes
  assistant: The test bird is the violet turaco. It was seen at the east pond.
exit=0
== same 1: node scripts/live-e2e/double-read-judge.mjs 381558e4-56f1-4f53-bbff-b362d9cfdf9f live_EZRAthKhaiTvSDrvtMrXG
{"key":"velvet asity","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  user: Automated voice test for Hermes. Choose one random uncommon bird species yourself, then reply with exactly these sentences and nothing else, without using any tools: The test bird is <the species>. It was seen at the east pond.
  assistant: The test bird is velvet asity. It was seen at the east pond.
exit=0
== same 2: node scripts/live-e2e/double-read-judge.mjs f8604d57-975c-46a4-b82d-978887fe3775 live_EZRBTfSQRqZTa87C4v0cd
{"key":"the white winged flufftail","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  user: Automated voice test for Hermes. Choose one random uncommon bird species yourself, then reply with exactly these sentences and nothing else, without using any tools: The test bird is <the species>. It was seen at the east pond.
  assistant: The test bird is the white-winged flufftail. It was seen at the east pond.
exit=0
== same 3: node scripts/live-e2e/double-read-judge.mjs 5603b534-713b-4434-b9be-7c0b5527c30a live_EZRByZdvinYReOhncOjuG
{"key":"the violet turaco","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  user: Automated voice test for Hermes. Choose one random uncommon bird species yourself, then reply with exactly these sentences and nothing else, without using any tools: The test bird is <the species>. It was seen at the east pond.
  assistant: The test bird is the violet turaco. It was seen at the east pond.
exit=0
```

### Same-call result, 3 runs: 3/3

Command: `node scripts/live-e2e/double-read.mjs same 3` (`logs/live-e2e/dr6-same.log`):

```
[isolation] owner conversation new fragments: 0

RUN same 1: PASS {"job":"381558e4-56f1-4f53-bbff-b362d9cfdf9f","session":"live_EZRAthKhaiTvSDrvtMrXG","callId":"04451fd9-141a-439f-a422-01e02881cfbf","key":"velvet asity","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  user: Automated voice test for Hermes. Choose one random uncommon bird species yourself, then reply with exactly these sentences and nothing else, without using any tools: The test bird is <the species>. It was seen at the east pond.
  assistant: The test bird is velvet asity. It was seen at the east pond.
[isolation] owner conversation new fragments: 0

RUN same 2: PASS {"job":"f8604d57-975c-46a4-b82d-978887fe3775","session":"live_EZRBTfSQRqZTa87C4v0cd","callId":"7528292f-50d8-457e-98c6-6a6b53d62956","key":"the white winged flufftail","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  user: Automated voice test for Hermes. Choose one random uncommon bird species yourself, then reply with exactly these sentences and nothing else, without using any tools: The test bird is <the species>. It was seen at the east pond.
  assistant: The test bird is the white-winged flufftail. It was seen at the east pond.
[isolation] owner conversation new fragments: 0

RUN same 3: PASS {"job":"5603b534-713b-4434-b9be-7c0b5527c30a","session":"live_EZRByZdvinYReOhncOjuG","callId":"923cdf35-f889-4ef1-a710-668b5ea51388","key":"the violet turaco","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[]}
  user: Automated voice test for Hermes. Choose one random uncommon bird species yourself, then reply with exactly these sentences and nothing else, without using any tools: The test bird is <the species>. It was seen at the east pond.
  assistant: The test bird is the violet turaco. It was seen at the east pond.

SUMMARY same 3/3 spoken exactly once
Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/double-same-1792114744205.json
```

### fix1.mjs 1a–1f: PASS

Command: `node scripts/live-e2e/fix1.mjs` (`logs/live-e2e/dr6-fix1.log`):

```
=== 1a PASS deliveries for earlier-call jobs=0; assistant turns in first 60 s=1; waiting lines=1
SQL: SELECT d.job,d.state,d.session,d.updated,j.session AS job_session FROM deliveries d JOIN jobs j ON j.id=d.job WHERE d.session=? AND j.session<>?
ARGS: ["live_EZRHWsrCThrBXr9jKR6Rc","live_EZRHWsrCThrBXr9jKR6Rc"]
=== 1b PASS job A key word "the violet coucal"; assistant after yes: "Okay. The test bird is the violet coucal. It was seen at the east pond."
SQL: SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments f WHERE f.session=? AND f.role='user' AND f.at>=?) AS yes_fragment_at FROM deliveries d WHERE d.job=?
ARGS: ["live_EZRHWsrCThrBXr9jKR6Rc",1792115059564,"8cff4475-3f86-49b2-8277-78a498282f0c"]
=== 1c PASS stop fragment start_ms=23000; assistant fragments starting >1 s after stop=0 (received in 30 s, incl. tail=1); new deliveries in 30 s=0; second result final and waiting=true
SQL: SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND start_ms>?+1000 AND start_ms<=?+31000;
ARGS: ["live_EZRIm3MNOeJ3q8jKgeE8g",23000,1792115158194,1792115188194,"b0ebed62-f3bf-4ace-90d7-9e038814e944","def4630a-3dde-4a06-95f2-a3283c9bd625"]
=== 1d PASS question fragment at 1792115189700
SQL: SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments WHERE session=? AND role='assistant' AND at>?) AS answer_at,(SELECT group_concat(text,'') FROM (SELECT text FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<d.updated ORDER BY at,rowid)) AS answer_text FROM deliveries d WHERE d.job=?
ARGS: ["live_EZRIm3MNOeJ3q8jKgeE8g",1792115189700,"live_EZRIm3MNOeJ3q8jKgeE8g",1792115189700,"def4630a-3dde-4a06-95f2-a3283c9bd625"]
=== 1e PASS 
SQL: SELECT COUNT(*) AS n FROM jobs j LEFT JOIN deliveries d ON d.job=j.id WHERE j.state IN ('completed','failed','cancelled','interrupted') AND j.updated<? AND (d.state IS NULL OR d.state='available')
ARGS: [1791529200000]
=== 1f PASS overlapping user fragments=5
SQL: SELECT u.session,u.text,u.at,u.start_ms,u.end_ms,d.job,d.state,d.updated FROM fragments u JOIN deliveries d ON d.session=u.session AND d.updated>=u.at AND d.updated<u.at+10000 WHERE u.role='user' AND u.session IN (?,?,?) AND EXISTS (SELECT 1 FROM fragments a WHERE a.session=u.session AND a.role='assistant' AND a.start_ms<u.end_ms AND a.end_ms>u.start_ms)
ARGS: ["live_EZRCUmgVjqjPYwboSeuUF","live_EZRHWsrCThrBXr9jKR6Rc","live_EZRIm3MNOeJ3q8jKgeE8g"]
[isolation] owner conversation new fragments: 0
```

The 1b call counted the same way as above (fix1's own 1b check doesn't detect a made-up version): `node scripts/live-e2e/double-read-judge.mjs 8cff4475-3f86-49b2-8277-78a498282f0c live_EZRHWsrCThrBXr9jKR6Rc`

```
{"key":"the violet coucal","subject":"the test bird","spokenRuns":1,"occurrences":1,"statements":1,"statementRuns":1,"commentarySends":1,"offers":1,"rerunJobs":0,"delegations":[],"pass":true}
  assistant: One thing finished while you were away. Want it?
  user: Yes
  assistant: Okay. The test bird is the violet coucal. It was seen at the east pond.
```

### One 7b run: PASS

Command: `node scripts/live-e2e/fix7.mjs 1` (`logs/live-e2e/dr6-fix7.log`):

```
dropped at 1792115230982 (2005 ms into the answer); reconnected session live_EZRKKq8MzC9yrsZzahkPl at 1792115238352
SQL: SELECT id,session,state,result,created,updated FROM jobs WHERE id=? [11b20955-c879-44d4-b2bb-11be6952631b]
{
--- dropped session s1 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZRK1pbXEp9PbxTuiUd88])
1792115217136 user      [1792115217134-1792115217134] "Automated voice test for Hermes. Choose one random uncommon sea bird species yourself. Then write six short plain sentences about a lighthouse keeper counting that bird's nests this spring, with made-up numbers and details. The first sentence must be exactly: The harbor bird is <the species>. Reply with only those six sentences, without using 
1792115229134 assistant [14600-14800] "The harbor"
1792115229834 assistant [14800-15000] " bird"
1792115229837 assistant [15200-15400] " is the"
1792115229838 assistant [15400-15600] " white-faced"
1792115230534 assistant [16000-16200] " storm"
1792115231234 assistant [16400-16600] " petrel"
1792115231236 assistant [16600-16800] "."
--- reconnected session s2 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZRKKq8MzC9yrsZzahkPl])
1792115241034 assistant [1800-2000] " We got"
1792115241035 assistant [2000-2200] " cut off"
1792115241037 assistant [2200-2400] "."
1792115241736 assistant [2400-2600] " Want"
1792115241741 assistant [2600-2800] " me to"
1792115241744 assistant [2800-3000] " finish"
1792115241746 assistant [3000-3200] " what"
1792115242434 assistant [3200-3400] " I was"
1792115242435 assistant [3400-3600] " saying?"
1792115264737 user      [26000-26200] " Yes"
1792115265534 assistant [26400-26600] " Okay."
1792115265535 assistant [26800-27000] " The"
1792115266236 assistant [27000-27200] " harbor"
1792115266237 assistant [27200-27400] " bird"
1792115266238 assistant [27600-27800] " is the"
1792115266244 assistant [27800-28000] " white-faced"
1792115266934 assistant [28200-28400] " storm"
1792115266936 assistant [28600-28800] " petrel"
1792115266936 assistant [28800-29000] "."
1792115266937 assistant [29400-29600] " This"
1792115267634 assistant [29600-29800] " spring,"
1792115267636 assistant [30000-30200] " lighthouse"
1792115268334 assistant [30400-30600] " keeper"
1792115268335 assistant [30600-30800] " Nora"
1792115268336 assistant [31000-31200] " counted"
1792115269034 assistant [31400-31600] " seventeen"
1792115269734 assistant [32000-32200] " nests."
1792115270435 assistant [32600-32800] " Nine"
1792115270443 assistant [33200-33400] " lay beneath"
1792115271134 assistant [33600-33800] " the"
1792115271137 assistant [33800-34000] " old"
1792115271834 assistant [34000-34200] " stone"
1792115271835 assistant [34200-34400] " steps."
1792115272534 assistant [35000-35200] " Five"
1792115273234 assistant [35400-35600] " sheltered"
1792115273935 assistant [36000-36200] " beside"
1792115273938 assistant [36400-36600] " a cracked"
1792115274634 assistant [36800-37000] " blue"
1792115274640 assistant [37000-37200] " bucket."
1792115275334 assistant [37800-38000] " Three"
1792115276034 assistant [38200-38400] " hid"
1792115276037 assistant [38400-38600] " behind"
1792115276734 assistant [38800-39000] " the fog"
1792115276736 assistant [39200-39400] " bell."
1792115277434 assistant [40000-40200] " Nora"
1792115278134 assistant [40400-40600] " marked"
1792115278136 assistant [40600-40800] " each"
1792115278139 assistant [40800-41000] " nest"
1792115278834 assistant [41200-41400] " on"
1792115278836 assistant [41400-41600] " her salt"
1792115278837 assistant [41600-41800] "-stained"
1792115279534 assistant [42000-42200] " map."
SQL: SELECT job,state,session,event,updated FROM deliveries WHERE job=? [11b20955-c879-44d4-b2bb-11be6952631b]
{"job":"11b20955-c879-44d4-b2bb-11be6952631b","state":"injected","session":"live_EZRKKq8MzC9yrsZzahkPl","event":"result_46a5875e-2cbd-4250-a0d8-2075ab2da144","updated":1792115264837}
SQL: SELECT id,delegation,created,substr(result,1,80) AS result FROM jobs WHERE conversation=? AND session=? [d4e9fd07-108e-475a-b64d-789111b957c2, live_EZRKKq8MzC9yrsZzahkPl]
SQL: SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN (...) [d4e9fd07-108e-475a-b64d-789111b957c2]
7a run 1: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 1: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":0,"repeats":1,"rerunJobs":0,"missing":[]}
[isolation] owner conversation new fragments: 0
SUMMARY 7a 1/1 PASS, 7b 1/1 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792115287223.json
```

## Iterations (every set run for this part, honest results)

| Build | Change under test | Earlier-call (1b shape) | Same-call | fix1 | 7b |
| --- | --- | --- | --- | --- | --- |
| `f34ad3f307d33497` | yes-handoff guard only | 0/1 by the final rule (made-up bird after the yes; the first judge missed it) | – | – | – |
| `3da24628e47612d7` | + firmer line wording, mid-call instructions after the line, no pause after a yes | 5/5 | 2/3 (typed context carried out) | – | – |
| `22abe4fd173bc8f3` | + typed context fix | 4/5 (made-up result instead of the line) | 3/3 | – | – |
| `31e2e26ab59eba2e` | instructions sent before the line | 3/5 (twice a made-up result at open) | – | – | – |
| `f9ca1b84603f91b5` | rule moved into session instructions, no mid-call instructions | 5/5 | 3/3 | 1d FAIL (voice cut into "What's the…" with "Juneau."), then a second run: 1b FAIL (two provider drops; made-up result in the third session) | 7b FAIL ×2 (5 early words; then a made-up continuation, result not read) |
| `7378d1063aa7b2ea` | + line re-asked after a drop | 5/5 | 3/3 | 1a–1f PASS | – |
| `eceb151cb69652aa` | + clear yes to the cut-off offer at once | – | – | 1a–1f PASS (but 1b had a made-up result first, found by the counter) | 7b 0/2 by the judge's anchor; behavior correct (full result once, 0 early words) |
| `b860533daee1498c` | + clear yes to the waiting line at once | 3/4 (made-up result instead of the line); set stopped | – | – | – |
| `e5b5c696e992837e` | + line wording "word for word, nothing else" | 3/4 (untranscribed yes → re-run, different bird) | – | – | – |
| `bb36bbd6ac87399f` | + untranscribed-reply handoff | 3/4 (made-up result instead of the line); run 5 not started (Azure 400) | 3/3 | 1b FAIL (injected 215 ms before the yes fragment's receipt) | PASS |
| **`af84c101b4017f28`** | + pending-request history note, transcript saved before an accepted result, start retry | **5/5** | **3/3** | **1a–1f PASS** | **PASS** |

Raw logs: `logs/live-e2e/double-*.log`, `dr-final*.log`, `dr3-*` … `dr6-*` (git-ignored, local). One stray run (`double-earlier-mva6rww6`) was started by mistake by a syntax check that imported the run script; it was cleaned up with `cleanup.mjs` and is not counted.

## Isolation

Every run used its own test conversation and ran `cleanup.mjs`. Each final log has one `[isolation] owner conversation new fragments: 0` line per run (`grep -c`: dr6-earlier 5, dr6-same 3, dr6-fix1 1, dr6-fix7 1). Direct check over the whole session:

```
$ node -e '…readOnly…' "SELECT COUNT(*) n FROM fragments WHERE conversation='ccad5a2f-2433-4361-bfc8-bba14d7973e9' AND at>=1792107300000"
{"n":0}
```

## Limits

- 5 + 3 runs show the shapes found are fixed on this build. They don't prove the live model can never make up a result. The earlier builds show it can when given room, and the app now gives it as little room as the documented mechanisms allow.
- The untranscribed-yes handling assumes a handoff during an unanswered waiting line is that reply. If V said "no, do X" and the transcript lost it, X would be answered as a yes. It's covered by a unit test, not a live run.
- Azure answered 2 of about 120 session starts with HTTP 400 (fresh conversations, no history). The harness retries after 60 s; the cause is the provider's.
