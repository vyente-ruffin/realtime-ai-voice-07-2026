# Fix 3 evidence: answer questions about V from memory, quickly

Spec: `docs/VOICE-FIX-PLAN.md`, Fix 3, checks 3a–3e. Build under test: the commit that adds this file (`/healthz` buildId `881afefee0109dc8` for the final 3a and 3b runs).

**Result: 3a PASS, 3b PASS, 3c PASS, 3d PASS, 3e PASS.**

## What changed

1. **Test isolation (before any live call).** Live test calls never touch V's conversation or memory.
   - `store.js`: conversations get a `test` column (the run name). Test conversations are left out of the "historical user speech" the voice prompt carries (`recentUserStatements`), and their speech is never sent to Hindsight as a voice memory save.
   - `server.js`: `POST /api/conversations` with `{test: {key, run}}` creates a test conversation. The key is random per server start and stored only in the owner-only state file, so only a local process can mint one. A page that reconnects with a test conversation id stays in it; every other page still gets V's conversation. Replayed history (`liveHistory`) is per conversation, so a test call replays only its own turns.
   - `scripts/live-e2e/harness.mjs`: `TestRun` / `testRun()` creates the test conversation, loads the page into it, and always runs cleanup at the end (even on failure). `launch()` refuses to start a call without a `TestRun`. `fix1.mjs` and `fix2.mjs` now use it too.
   - `scripts/live-e2e/cleanup.mjs`: waits until Hindsight has no pending retain for the run's documents, then invalidates (`PATCH /memories/{id}` `{state: "invalidated"}`, the documented curation call; nothing is deleted) every memory from: the run's Hermes run sessions (document id and `session:`/`parent:` tags, plus child sessions from Hermes's `state.db`, read-only), `hermes -z` sessions started from the run's own working directory, voice saves of the run's test conversations, and anything created during the run that holds one of its random test words. It then proves the result: recall hits for the test words, still-valid memories per session, the three prepared voice memories (refreshed through the documented refresh call if they picked up a test word), and Hermes's `MEMORY.md`/`USER.md` (reported, never edited).
2. **Hermes session scope.** `worker.js` `sessionFor()`: one Hermes session per voice call (`voice-<conversation>-<call session>`), not per conversation. Memory continuity stays with the main profile's Hindsight auto-recall, unchanged.
3. **Fixes for failing checks only** (no facts about V anywhere):
   - 3d failed (`I don't have details on her work.`): speech rule in `policy.js` — the prepared facts are a summary; a personal question they don't answer is handed to the backend with he/she/they resolved from the conversation, never "I don't know" or "who?".
   - 3a failed (`a family reunion in Austin`, a merged detail): speech rule — say remembered facts as written, keep each name, place and date attached to what it belongs to, add or merge nothing.
   - 3c failed (3b at 10.3 s; the 3d follow-up at 21.3 s, then 12.4 s, then 11.9 s): (a) A new per-call Hermes session has no auto-recall queued for its first turn (Hermes API server docs, "Long-term memory scoping": "A request without any continuation starts a fresh session and ... has nothing queued yet"). So before `POST /v1/runs` the app runs Hindsight's documented `POST /memories/recall` with the main profile's own recall settings (`recall_budget`, `recall_max_tokens`, `recall_max_input_chars`, `recall_types` from `~/.hermes/hindsight/config.json`) on what the user said in the request, drops repeated facts, and passes the result in the run `instructions`. A failed recall sends "Nothing recalled." after at most 5 s and never blocks the job. The worker rule says to answer from that recall and look up again only when it has nothing relevant. (b) Voice runs send the documented request-scoped `model_options.reasoning_effort: "medium"` (Hermes API server docs, "Per-request model selection"). The main profile's `reasoning_effort: max` stays as is for Telegram and every other channel. `VOICE_REASONING_EFFORT` overrides it, and an empty value turns it off.

**For V to know:** medium reasoning applies to every voice job, including research tasks, not only memory questions. If voice research answers get worse, set `VOICE_REASONING_EFFORT=` in the drop-in to go back to the profile's own effort.

## Code checks

`npm run -s test:live` after the last code change (Fix 1 and Fix 2 tests included; Fix 2's session-id tests were updated to the per-call id):

```
✔ isolation: a test run gets its own conversation; the owner's conversation is never handed out to it (256.244533ms)
✔ isolation: test speech never reaches the owner's prompt history or voice memory saves (31.52954ms)
✔ session scope: each voice call has its own Hermes session; a later call never continues an earlier one (74.250224ms)
✔ cleanup: the live harness always runs cleanup and the cleanup uses only the documented invalidate call (0.422094ms)
✔ 3a/3c: prepared memory is answered directly, without a waiting preface (1.30001ms)
✔ 3a: remembered facts are said as written, never merged or embellished (0.224055ms)
✔ 3d: a personal detail missing from the summary is handed to the backend, never 'I don't know' or 'who?' (0.235461ms)
✔ 3e: the Fix 3 diff adds none of the user's remembered facts to code (126.479506ms)
✔ 3b/3c: a voice job's Hermes run carries memory recalled for its request, so Hermes answers in one step (100.156383ms)
✔ 3c: a failed or slow memory recall never blocks the job (26.815783ms)
✔ 3c: voice runs ask Hermes for medium reasoning effort through the documented model_options (38.324832ms)
✔ 3d: recalled memory drops repeated facts, so the useful ones are not crowded out (26.167252ms)
ℹ tests 82
ℹ pass 82
ℹ fail 0

```

## Isolation proof (step 1)

Command: `node scripts/live-e2e/fix3.mjs isolation` (session `live_EXCEEYbHzRpwYC3prxXyB`). A `hermes -z` memory save with one random word, then a real voice call that hands a request with a second random word to Hermes. Both are auto-retained, then cleaned up:

```
test words: voice=chickadee oneshot=marmalade
hermes -z: Q: Remember your isolation probe word.
G: Retain it for future recall.

Saved, V: your isolation probe word is marmalade.

R: none — no supporting source
test run fix3-iso-mv1gs4io, test conversation 566bbbc5-a090-40ff-8b76-a912563a9354, session live_EXCEEYbHzRpwYC3prxXyB

--- Q: Please search my notes for the word chickadee.
question audio ended at=1791580547353 (2026-10-09T21:15:47.353Z); last user fragment at=1791580547859
answer start at=1791580584957 (2026-10-09T21:16:24.957Z)
latency(answer fragments.at - question end)=37604 ms; latency(audio clock)=38000 ms; jobs=1
ASSISTANT:  Mm. Alright. I’ll look for that. What’s on your mind while I’m doing that? |  I know you’re V, married to Teresa, living in the Dallas–Fort Worth area. You prefer short, plain-English answers, no fluff. And I also know you’re focused on a few current projects. I see the search finished. Want the result? No hits for "chickadee" — not in your notes’ text and not in their titles.

TRANSCRIPT (fragments joined per speaker):
2026-10-09T21:15:40.857Z assistant:  Hey there!
2026-10-09T21:15:46.460Z user:  Please search my notes for the word chickadee
2026-10-09T21:15:48.557Z assistant:  Mm. Alright. I’ll look for that. What’s on your mind while I’m doing that?
2026-10-09T21:16:10.257Z assistant:  I know you’re V, married to Teresa, living in the Dallas–Fort Worth area. You prefer short, plain-English answers, no fluff. And I also know you’re focused on a few current projects. I see the search finished. Want the result? No hits for "chickadee" — not in your notes’ text and not in their titles.
JOBS: [
 {
  "state": "completed",
  "run_id": "run_d1e4faa10fee43d594ca5be8fc09e0d1",
  "hermes_session": "voice-566bbbc5-a090-40ff-8b76-a912563a9354-live_EXCEEYbHzRpwYC3prxXyB",
  "result": "I found no matches for “chickadee” in your notes, V—neither in the text nor the note titles.",
  "hermes": {
   "run": "run_d1e4faa10fee43d594ca5be8fc09e0d1",
   "session": "voice-566bbbc5-a090-40ff-8b76-a912563a9354-live_EXCEEYbHzRpwYC3prxXyB",
   "status": "completed",
   "seconds": 27.7,
   "inputTokens": 190773,
   "output": "I found no matches for “chickadee” in your notes, V—neither in the text nor the note titles."
  }
 }
]
[cleanup] {"run":"fix3-iso-mv1gs4io","testConversations":1,"hermesSessions":["voice-566bbbc5-a090-40ff-8b76-a912563a9354-live_EXCEEYbHzRpwYC3prxXyB","20261009_211522_4d412f"],"oneshotSessions":1,"voiceSaveDocuments":0,"memoriesFound":3,"bySource":{"hermes-session":1,"test-word":2},"invalidated":2,"prunedWithTheirSource":1,"stillValidPerSession":{"voice-566bbbc5-a090-40ff-8b76-a912563a9354-live_EXCEEYbHzRpwYC3prxXyB":0,"20261009_211522_4d412f":0},"retainsStillPending":0,"recallHitsForTestWords":{"chickadee":0,"marmalade":0},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

=== isolation PASS
SQL: SELECT COUNT(*) AS n FROM fragments WHERE conversation=? AND at>=?
ARGS: ["ccad5a2f-2433-4361-bfc8-bba14d7973e9",1791580514784]
OWNER ROWS: [{"n":0}]
TEST CONVERSATION FRAGMENTS: [{"n":72}]
RECALL HITS FOR TEST WORDS: {"chickadee":0,"marmalade":0}

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix3-isolation-1791580606879.json
```

V's conversation after all the runs in this file. Its fragment count is the same as before the work started, and its newest fragment predates the work (1791568586690 = 2026-10-09T18:36:26Z). Every test call landed in its own test conversation:

```
$ node -e '...SELECT COUNT(*) n, MAX(at) last FROM fragments WHERE conversation="ccad5a2f-..." ; SELECT c.test, COUNT(f.id) ... GROUP BY c.id'
{"n":7443,"last":1791568586690}
[{"test":null,"n":7443},{"test":"fix3-iso-mv1gpom5","n":41},{"test":"fix3-iso-mv1gs4io","n":72},{"test":"fix3-3a-mv1guv7w","n":92},{"test":"fix3-3b-mv1gxre3","n":18},{"test":"fix3-3a-mv1hdfpv","n":151},{"test":"fix3-3a-mv1hji0q","n":93},{"test":"fix3-3a-mv1hn8l1","n":115},{"test":"fix3-3a-mv1hr1ly","n":136},{"test":"fix3-3b-mv1hu4kt","n":19}]
```

The first isolation run (`fix3-iso-mv1gpom5`) found two bugs in `cleanup.mjs`: the Hindsight operations list caps `limit` at 100, and an observation that was pruned with its source fact returns 404. Both are fixed, and that run was cleaned again by hand: `node scripts/live-e2e/cleanup.mjs fix3-iso-mv1gpom5 --since 1791580400000 --word marmalade --word kestrel` (output below).

### Cleanup output from every run

```
### fix3-isolation-run1-cleanup
[cleanup] {"run":"fix3-iso-mv1gpom5","testConversations":1,"hermesSessions":["voice-ec79736e-f960-48bd-aeb7-84782788cc46-live_EXCCQcEAb6ugjX2UAPZoW","20261009_211326_bce018"],"oneshotSessions":1,"voiceSaveDocuments":0,"memoriesFound":2,"bySource":{"test-word":2},"invalidated":1,"prunedWithTheirSource":1,"stillValidPerSession":{"voice-ec79736e-f960-48bd-aeb7-84782788cc46-live_EXCCQcEAb6ugjX2UAPZoW":0,"20261009_211326_bce018":0},"retainsStillPending":0,"recallHitsForTestWords":{"marmalade":0,"kestrel":0},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
### fix3-isolation-run2
[cleanup] {"run":"fix3-iso-mv1gs4io","testConversations":1,"hermesSessions":["voice-566bbbc5-a090-40ff-8b76-a912563a9354-live_EXCEEYbHzRpwYC3prxXyB","20261009_211522_4d412f"],"oneshotSessions":1,"voiceSaveDocuments":0,"memoriesFound":3,"bySource":{"hermes-session":1,"test-word":2},"invalidated":2,"prunedWithTheirSource":1,"stillValidPerSession":{"voice-566bbbc5-a090-40ff-8b76-a912563a9354-live_EXCEEYbHzRpwYC3prxXyB":0,"20261009_211522_4d412f":0},"retainsStillPending":0,"recallHitsForTestWords":{"chickadee":0,"marmalade":0},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-3a-run1
[cleanup] {"run":"fix3-3a-mv1guv7w","testConversations":1,"hermesSessions":[],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-3b-run1
[cleanup] {"run":"fix3-3b-mv1gxre3","testConversations":1,"hermesSessions":["voice-9351f581-c37f-4158-9334-60dcac99845e-live_EXCRn8zCN9KNKJZDKlecT","20261009_211942_2a6ce0"],"oneshotSessions":1,"voiceSaveDocuments":0,"memoriesFound":3,"bySource":{"hermes-session":3},"invalidated":2,"prunedWithTheirSource":1,"stillValidPerSession":{"voice-9351f581-c37f-4158-9334-60dcac99845e-live_EXCRn8zCN9KNKJZDKlecT":0,"20261009_211942_2a6ce0":0},"retainsStillPending":0,"recallHitsForTestWords":{"pumpernickel":0},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-3a-run2
[cleanup] {"run":"fix3-3a-mv1hdfpv","testConversations":1,"hermesSessions":["voice-53a16ef7-4c68-4af1-85c5-9d4f7c7d2d9d-live_EXCTust9vShvTScQxqxiY"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-53a16ef7-4c68-4af1-85c5-9d4f7c7d2d9d-live_EXCTust9vShvTScQxqxiY":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-effort-run1
[cleanup] {"run":"fix3-effort-mv1hh5im","testConversations":0,"hermesSessions":["voice-e2e-fix3-effort-mv1hh5im-default","voice-e2e-fix3-effort-mv1hh5im-medium","voice-e2e-fix3-effort-mv1hh5im-low"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-e2e-fix3-effort-mv1hh5im-default":0,"voice-e2e-fix3-effort-mv1hh5im-medium":0,"voice-e2e-fix3-effort-mv1hh5im-low":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-3a-run3
[cleanup] {"run":"fix3-3a-mv1hji0q","testConversations":1,"hermesSessions":["voice-5053398c-c831-4717-b433-9ab371db02b2-live_EXCYTvsSTIUarDpqJ7WDx"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-5053398c-c831-4717-b433-9ab371db02b2-live_EXCYTvsSTIUarDpqJ7WDx":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-3a-run4
[cleanup] {"run":"fix3-3a-mv1hn8l1","testConversations":1,"hermesSessions":["voice-27c1a76d-091f-45c9-9098-f1f77e3bae63-live_EXCbHP6jJL8R4sWuujjsb"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":2,"bySource":{"hermes-session":2},"invalidated":1,"prunedWithTheirSource":1,"stillValidPerSession":{"voice-27c1a76d-091f-45c9-9098-f1f77e3bae63-live_EXCbHP6jJL8R4sWuujjsb":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-effort-run2
[cleanup] {"run":"fix3-effort-mv1hqfkk","testConversations":0,"hermesSessions":["voice-e2e-fix3-effort-mv1hqfkk-medium","voice-e2e-fix3-effort-mv1hqfkk-medium"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-e2e-fix3-effort-mv1hqfkk-medium":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-3a-run5
[cleanup] {"run":"fix3-3a-mv1hr1ly","testConversations":1,"hermesSessions":["voice-b076b5cb-b0bc-41bf-97b6-fa52e2f3f1d5-live_EXCe9Q7QuljTtwUI6lhcD"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-b076b5cb-b0bc-41bf-97b6-fa52e2f3f1d5-live_EXCe9Q7QuljTtwUI6lhcD":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0
### fix3-3b-run2
[cleanup] {"run":"fix3-3b-mv1hu4kt","testConversations":1,"hermesSessions":["voice-b66b3fbd-63d0-47ee-9c08-026778fd3b1e-live_EXCqAspJmDUHkXZub5C7H","20261009_214452_24341e"],"oneshotSessions":1,"voiceSaveDocuments":0,"memoriesFound":4,"bySource":{"hermes-session":2,"test-word":2},"invalidated":2,"prunedWithTheirSource":2,"stillValidPerSession":{"voice-b66b3fbd-63d0-47ee-9c08-026778fd3b1e-live_EXCqAspJmDUHkXZub5C7H":0,"20261009_214452_24341e":0},"retainsStillPending":0,"recallHitsForTestWords":{"tamarind":0},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

```

Each line shows `recallHitsForTestWords` all 0, `stillValidPerSession` all 0, no prepared-memory or Hermes memory-file hits, and 0 new fragments in V's conversation.

## Hermes session scope: answer time before and after (step 2)

**Before:** the per-conversation session's real runs from earlier today (`node scripts/live-e2e/fix3.mjs sessions <13 run ids from logs/live-e2e>`, `GET /v1/runs/{id}`). Columns are session tail, seconds, input tokens and output:

```
2f-2433-4361-bfc8-bba14d7973e9 12.2 80108 Your test word is quokka, V.
361-bfc8-bba14d7973e9-0f79cdfa 9.8 75463 V, this server has been up for 16 days, 5 hours, and 48 minu
2f-2433-4361-bfc8-bba14d7973e9 10.5 159680 Teresa has a background in commercial real estate and serves
2f-2433-4361-bfc8-bba14d7973e9 53.2 106980 V, Bitcoin was $82,402.31 USD on Coinbase at 19:26 UTC. Sour
2f-2433-4361-bfc8-bba14d7973e9 184.9 67029 V, the three-minute wait finished successfully.
2f-2433-4361-bfc8-bba14d7973e9 8.3 132630 Your memory check word is marzipan, V.
2f-2433-4361-bfc8-bba14d7973e9 3.7 72875 Your memory check word is marzipan, V.
2f-2433-4361-bfc8-bba14d7973e9 8.5 33279 V, the task ended immediately: sleep180 was not found on thi
2f-2433-4361-bfc8-bba14d7973e9 15.5 166484 Teresa has a background in commercial real estate and is a f
2f-2433-4361-bfc8-bba14d7973e9 6.6 84747 V, the root filesystem currently has 42 GB of free disk spac
2f-2433-4361-bfc8-bba14d7973e9 14.2 176216 Your lucky charm word is halcyon, V.
2f-2433-4361-bfc8-bba14d7973e9 3.8 46897 Your memory check word is quokka, V.
```

The memory questions took 3.7–15.5 s, with 47k–176k input tokens, growing with the session.

**After, per-call session only** (3b baseline run, session `voice-9351f581-…-live_EXCRn8zCN9KNKJZDKlecT`): 8.4 s, 36,382 input tokens, answered after one `hindsight_recall` tool call (model step 2.6 s + recall 3.0 s + final step 2.4 s). The token count no longer grows. The time is set by the three model steps at the profile's `reasoning_effort: max`.

**After, per-call session + recall in the run + medium effort.** `node scripts/live-e2e/fix3.mjs effort` sends the same 3d follow-up straight to the Runs API, in fresh test sessions:

```
{"effort":"default","recallMs":2137,"run":"run_7c476536506742a1be1595ec63c61fa8","session":"voice-e2e-fix3-effort-mv1hh5im-default","status":"completed","seconds":7.6,"inputTokens":42851,"output":"Teresa is one of the financial reviewers in her team’s CM Sheet approval process. I don’t have her exact job title in me","totalMs":10009}
{"effort":"medium","recallMs":2010,"run":"run_e76c97a17e1e4587965ac248113ee82c","session":"voice-e2e-fix3-effort-mv1hh5im-medium","status":"completed","seconds":3.6,"inputTokens":19225,"output":"Teresa is one of seven financial reviewers in the CM Sheet approval process. I don’t have her job title in memory.","totalMs":6004}
{"effort":"low","recallMs":2329,"run":"run_f935f837c55046c7b920a2d6547dd4bf","session":"voice-e2e-fix3-effort-mv1hh5im-low","status":"completed","seconds":4.5,"inputTokens":19225,"output":"Teresa is one of seven financial reviewers in the CM Sheet approval process, V. I don’t have her job title in memory.","totalMs":10334}
[cleanup] {"run":"fix3-effort-mv1hh5im","testConversations":0,"hermesSessions":["voice-e2e-fix3-effort-mv1hh5im-default","voice-e2e-fix3-effort-mv1hh5im-medium","voice-e2e-fix3-effort-mv1hh5im-low"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-e2e-fix3-effort-mv1hh5im-default":0,"voice-e2e-fix3-effort-mv1hh5im-medium":0,"voice-e2e-fix3-effort-mv1hh5im-low":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix3-effort-1791581724133.json
```

After the worker rule change (`node scripts/live-e2e/fix3.mjs effort medium,medium`):

```
{"effort":"medium","recallMs":2564,"run":"run_323503b8a223425da9e0e767633bd64b","session":"voice-e2e-fix3-effort-mv1hqfkk-medium","status":"completed","seconds":3.6,"inputTokens":20796,"output":"Teresa is one of seven financial reviewers in the CM Sheet approval process, V. My memory doesn’t record her job title o","totalMs":6504}
{"effort":"medium","recallMs":2311,"run":"run_4ca26dc8ef0e4c1ab543819bb4967e92","session":"voice-e2e-fix3-effort-mv1hqfkk-medium","status":"completed","seconds":2.7,"inputTokens":25120,"output":"She handles financial review in the CM Sheet approval process, V—she’s one of seven financial reviewers. I don’t have he","totalMs":5301}
[cleanup] {"run":"fix3-effort-mv1hqfkk","testConversations":0,"hermesSessions":["voice-e2e-fix3-effort-mv1hqfkk-medium","voice-e2e-fix3-effort-mv1hqfkk-medium"],"oneshotSessions":0,"voiceSaveDocuments":0,"memoriesFound":0,"bySource":{},"invalidated":0,"prunedWithTheirSource":0,"stillValidPerSession":{"voice-e2e-fix3-effort-mv1hqfkk-medium":0},"retainsStillPending":0,"recallHitsForTestWords":{},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix3-effort-1791582137692.json
```

Final build in a real call: the 3d follow-up's Hermes run took 2.4 s with 20,730 tokens (3a run below), and the 3b run took 3.4 s with 20,563 tokens.

---

## 3a: Correct from memory — PASS

Command: `node scripts/live-e2e/fix3.mjs 3a` on the final build, test run `fix3-3a-mv1hr1ly`, session `live_EXCe9Q7QuljTtwUI6lhcD`. The questions are read from the plan. Each spoken answer is printed next to a Hindsight recall on bank `hermes` for the same question (top 6 of each shown; full output in `logs/live-e2e/fix3-3a-run5.txt`):

```
--- Q: What's my name?
question audio ended at=1791582152134 (2026-10-09T21:42:32.134Z); last user fragment at=1791582152488
answer start at=1791582152489 (2026-10-09T21:42:32.489Z)
latency(answer fragments.at - question end)=355 ms; latency(audio clock)=0 ms; jobs=0
ASSISTANT:  Vyente Ruffin — you go by V.
HINDSIGHT RECALL (bank hermes):
  2026-08-29T00:28:07+00:00 | The assistant created `homelab/jarvis-notes.md` containing: “Hello, my name is JARVIS and it is 5:27 p.m.” | When: Saturday, August 29, 2026 at 5:27 p.m. | Involving: Hermes Agent and user | The user wanted a file for notes from the conversation.
  2026-09-06T05:59:27+00:00 | The user's name is Viente, spelled V-i-e-n-t-e, not Valiente; he goes by V. | Involving: Viente (the user) | Corrects a prior misspelling of his name.
  2026-08-29T00:26:45+00:00 | V's full name is Vyente Ruffin. | Involving: V (Vyente Ruffin)
  2026-09-06T05:59:32+00:00 | V's full name is Vyente Ruffin, and he goes by V; he clarified that his name should be rendered “Viente,” not “Valiente.” | When: Saturday, September 5, 2026 | Involving: V (Vyente Ruffin), the user | This records V's explicit correction of his name.
  2026-08-28T18:23:14+00:00 | The user's name is V (Vyente). | Involving: V (Vyente)
  2026-09-06T05:59:32+00:00 | V goes by V. Earlier records identified him as Vyente Ruffin and associated “Viente” with his own name, but his more recent correction says “Viente” is his wife's name, leaving the rendering of his full name unresolved.

--- Q: What do you know about me?
question audio ended at=1791582167196 (2026-10-09T21:42:47.196Z); last user fragment at=1791582167888
answer start at=1791582167889 (2026-10-09T21:42:47.889Z)
latency(answer fragments.at - question end)=693 ms; latency(audio clock)=0 ms; jobs=0
ASSISTANT:  You go by V, you're married to Teresa, and you're a senior Microsoft engineer. You live in the Dallas–Fort Worth area after growing up in Fontana and spend about 13 years in Boston. You specialize in cloud, AI, DevOps.
HINDSIGHT RECALL (bank hermes):
  2026-09-23T22:02:51.010000+00:00 | JARVIS reported (not verified) that answering V's broad “what do you know about me” question took 81 seconds because the memory system synthesized a full profile rather than performing a quick lookup, causing later requests to queue behind it. | When: September 23, 2026 | Involving: V; JARVIS
  2026-08-31T02:21:25+00:00 | V established a project-creation standard: any request to create or start a project should trigger conversational collection of a mandatory name and description, an optional repository, and a requested but optional goal; “I don't know” must be accepted for the goal and noted in README.md. | Involvin
  2026-09-24T02:09:31+00:00 | V stated that JARVIS should not assume he already knows a project's context; when explaining work, it should first explain the overall scope and what is being discussed. | When: September 23, 2026 | Involving: V, JARVIS | V objected that the prior explanation assumed knowledge and did not establish 
  2026-09-27T17:45:31.020000+00:00 | On September 27, 2026, V stated that he must proactively define and demonstrate capabilities rather than rely on leadership to specify what to build, because leaders may not know what is possible.
  2026-09-15T15:14:55+00:00 | V expects direct, concrete project status updates and rejects vague or overly elaborate explanations, especially when work is described as blocked. | Involving: V (Vyente Ruffin, user) | He wants to know exactly what is done, what is stopped, and what he is waiting for.
  2026-08-26T19:01:30.170000+00:00 | User is frustrated with the assistant's response and accuses it of not verifying information, calling it an 'asshole' and telling it to 'look at the fucking docs and know idiot'. | When: 2026-08-26 | Involving: User (Vyente Ruffin), Hermes Agent | User is dissatisfied with the assistant's app

--- Q: Who is Teresa?
question audio ended at=1791582191046 (2026-10-09T21:43:11.046Z); last user fragment at=1791582190990
answer start at=1791582191688 (2026-10-09T21:43:11.688Z)
latency(answer fragments.at - question end)=698 ms; latency(audio clock)=0 ms; jobs=0
ASSISTANT:  Teresa is your spouse.
HINDSIGHT RECALL (bank hermes):
  2026-09-06T01:46:16+00:00 | Teresa is V's wife.
  2026-09-06T01:41:00.030000+00:00 | Teresa is V's wife.
  2026-08-31T20:43:23+00:00 | Teresa is V's wife.
  2026-08-29T22:32:48.010000+00:00 | Teresa is V's wife.
  2026-08-29T00:20:08.010000+00:00 | Teresa is V's wife.
  2026-08-28T18:15:27+00:00 | Teresa is the user's wife. | Involving: Teresa (user's wife)

--- Q: And what does she do?
question audio ended at=1791582205339 (2026-10-09T21:43:25.339Z); last user fragment at=1791582205692
answer start at=1791582211288 (2026-10-09T21:43:31.288Z)
latency(answer fragments.at - question end)=5949 ms; latency(audio clock)=7000 ms; jobs=1
ASSISTANT:  What does she do? I'll have a look. |  She handles CM Sheet approvals as one of seven financial reviewers, but I don't have her exact job title or employer noted.
HINDSIGHT RECALL (bank hermes):
  2026-09-01T21:35:13.150000+00:00 | Teresa must be asked whether she requires three documents combined into one file or will accept three separate files in one folder; combining them requires paying for a better tool, and her original request was overridden without her knowledge. | When: Tuesday, September 1, 2026 | Involving: 
  2026-09-01T20:11:47+00:00 | V is creating the CM Sheet project for Teresa, his wife, so she can run its approval process without him. The workflow moves from property analyst to property manager, accounts payable/PDF generation, financial review, and archiving. | Involving: V (project creator), Teresa (V's wife) | The project 
  2026-09-01T21:34:12.040000+00:00 | V's goal is to ship Teresa's CM Sheet approval process so her team can stop relying on email. | Involving: V (Vyente Ruffin); Teresa (V's wife); Teresa's team | Replace the team's email-based approval workflow.
  2026-09-01T21:35:13.100000+00:00 | The CM Sheet project exists because auditors flagged Teresa's team's inconsistent, case-by-case email process and lack of an approval trail. V defines its scope narrowly: every charge-modification sheet must follow the same approval process and preserve proof of who approved what; features se
  2026-08-31T17:46:48.020000+00:00 | V's phone already reports his location, and the system identifies when he is home; Teresa's phone is not onboarded, so she is detectable only while connected to V's Wi-Fi. | Involving: V (user), Teresa (V's wife) | Teresa's phone onboarding is the remaining household location-detection gap.
  2026-09-06T01:38:26.120000+00:00 | Teresa is V's wife.

--- Q: What am I working on right now?
question audio ended at=1791582231195 (2026-10-09T21:43:51.195Z); last user fragment at=1791582231590
answer start at=1791582232988 (2026-10-09T21:43:52.988Z)
latency(answer fragments.at - question end)=1793 ms; latency(audio clock)=600 ms; jobs=0
ASSISTANT:  Your current focus is the Austin Family Reunion in Fresno, happening October 9th through the 11th. The Teresa CM Sheet DEV work is on pause, and 405network is awaiting verification. Right now, it's9:44 PM on October 9th, UTC.
HINDSIGHT RECALL (bank hermes):
  2026-08-28T17:58:10.030000+00:00 | V is currently working on JARVIS voice-interface work, the Youni for Business rebuild, 405Network website and AI business projects, and ongoing home-lab and memory-system tuning. | When: August 28, 2026 | Involving: V (Vyente Ruffin)
  2026-09-21T15:44:26.010000+00:00 | V stated that repository main-branch updates should eventually keep JARVIS's work memories current, but decided not to set up that automation now; the current scope is to inspect repository organization and sync relevant work context into memory. | When: September 21, 2026 | Involving: V | Au
  2026-08-28T18:15:22.010000+00:00 | V is working on a Youni rewrite in Kotlin, realtime voice work on Azure, and a home lab involving Hermes agents, Hindsight memory tagging, and Graylog logging. | When: August 28, 2026 | Involving: V | These are V's current projects.
  2026-09-21T16:44:02+00:00 | V stated that the SE repository at https://github.com/vyente-ruffin/SE must keep JARVIS updated on his Microsoft-work context when it syncs to main, but requested no automation be built yet. | When: September 21, 2026 | Involving: V; JARVIS | V wants JARVIS to remain current on what he is working on
  2026-09-18T16:44:33.610351+00:00 | SE's README.md is its living record and must be read before any project work. | When: Before working on SE | Involving: Anyone working on SE | Ensures work uses the project's current verified context.
  2026-08-26T16:59:52.070000+00:00 | User has a history of working on various projects including Python, HTML, PowerShell, and Bicep | When: 2024-05-03 | Involving: user
```

```
TRANSCRIPT (fragments joined per speaker):
2026-10-09T21:42:31.789Z user:  What's my name
2026-10-09T21:42:32.489Z assistant:  Vyente Ruffin — you go by V.
2026-10-09T21:42:46.488Z user:  What do you know about me
2026-10-09T21:42:47.889Z assistant:  You go by V, you're married to Teresa, and you're a senior Microsoft engineer. You live in the Dallas–Fort Worth area after growing up in Fontana and spend about 13 years in Boston. You specialize in cloud, AI, DevOps.
2026-10-09T21:43:10.288Z user:  Who is Teresa
2026-10-09T21:43:11.688Z assistant:  Teresa is your spouse.
2026-10-09T21:43:24.989Z user:  And what does she do
2026-10-09T21:43:26.390Z assistant:  What does she do? I'll have a look.
2026-10-09T21:43:31.288Z assistant:  She handles CM Sheet approvals as one of seven financial reviewers, but I don't have her exact job title or employer noted.
2026-10-09T21:43:50.888Z user:  What am I working on right now
2026-10-09T21:43:52.988Z assistant:  Your current focus is the Austin Family Reunion in Fresno, happening October 9th through the 11th. The Teresa CM Sheet DEV work is on pause, and 405network is awaiting verification. Right now, it's9:44 PM on October 9th, UTC.
JOBS: [
```

Fact by fact, with the recall that supports each one (`/tmp/recall.sh "<query>"`, which is `POST /v1/default/banks/hermes/memories/recall` with `budget: mid`):
- "Vyente Ruffin — you go by V": `V's full name is Vyente Ruffin.`; `he goes by V`.
- "married to Teresa" / "Teresa is your spouse": `Teresa is V's wife.`
- "senior Microsoft engineer … cloud, AI, DevOps": `V is Vyente Ruffin, a senior Microsoft engineer working in cloud infrastructure, AI, and DevOps.`
- "Dallas–Fort Worth … growing up in Fontana … about 13 years in Boston": `V grew up in Fontana, California, later lived in Boston for about 13 years, and by September 2026 had lived in the Dallas–Fort Worth area for about six years.`
- "CM Sheet approvals as one of seven financial reviewers, … no exact job title": `The CM Sheet process covers 29 people across 5 roles and 58 entities; Teresa is one of seven financial reviewers, not the sole approver.`
- "Austin Family Reunion in Fresno, October 9th through the 11th": `The next Austin Family Reunion is planned for October 9–11, 2026, in Fresno, California.`
- "Teresa CM Sheet DEV work is on pause": `On October 5, 2026, V stated that CM Sheet DEV changes are paused and no changes should be made.`
- "405network is awaiting verification": `The 405network-site website is live, but final acceptance awaits confirmation that the business email … was received`.
- "it's 9:44 PM on October 9th, UTC" is the browser clock, not memory. It was correct for the headless browser's zone (UTC). The harness now runs the browser in `America/Los_Angeles` so clock lines match a real call.

Nothing spoken is made up. The baseline run on the build before the speech rules (`fix3-3a-mv1guv7w`, session `live_EXCFwPu3v0PjkbP3WofbX`) failed:

```
TRANSCRIPT (fragments joined per speaker):
2026-10-09T21:17:26.257Z assistant:  Ready when you are.
2026-10-09T21:17:30.456Z user:  What's my name
2026-10-09T21:17:31.161Z assistant:  Vyente. You go by V.
2026-10-09T21:17:45.156Z user:  What do you know about me
2026-10-09T21:17:46.558Z assistant:  You're Vyente 'V' Ruffin, a senior customer-facing engineer at Microsoft, specializing in cloud, AI, and DevOps. You live in the Dallas–Fort Worth area and run a private home lab. You're married to Teresa and love Houston’s food culture.
2026-10-09T21:18:10.356Z user:  Who is Teresa
2026-10-09T21:18:11.058Z assistant:  Your wife.
2026-10-09T21:18:24.357Z user:  And what does she do
2026-10-09T21:18:25.759Z assistant:  I don't have details on her work.
2026-10-09T21:18:39.056Z user:  What am I working on right now
2026-10-09T21:18:40.459Z assistant:  You're prioritizing, a family reunion in Austin and moving an acquisition dashboard off your Mac mini, while juggling customer engagements at Microsoft.
JOBS: []
```

"a family reunion in Austin" is wrong (memory: the Austin Family Reunion is in Fresno), and the 3d follow-up was answered "I don't have details on her work." Runs 2–4 (`logs/live-e2e/fix3-3a-run2..4.txt`) had no made-up facts, and only 3c failed on the follow-up.

## 3b: Fresh memory, not canned — PASS

Command: `node scripts/live-e2e/fix3.mjs 3b` on the final build. It picks a random word with no memory, valid or invalidated, tells it to the main profile with `hermes -z` (from the run's own directory, so cleanup finds that session), waits 10 minutes, then asks the voice:

```
2026-10-09T21:44:47.994Z hermes -z "Remember this: my garden test word is tamarind."
2026-10-09T21:44:47.994Z Q: Remember your garden test word.
G: Retain it for future recall.

Saved, V: your garden test word is tamarind.
waiting 10 minutes
test run fix3-3b-mv1hu4kt, test conversation b66b3fbd-63d0-47ee-9c08-026778fd3b1e, session live_EXCqAspJmDUHkXZub5C7H

--- Q: What's my garden test word?
question audio ended at=1791582897148 (2026-10-09T21:54:57.148Z); last user fragment at=1791582897996
answer start at=1791582905695 (2026-10-09T21:55:05.695Z)
latency(answer fragments.at - question end)=8547 ms; latency(audio clock)=8800 ms; jobs=1
ASSISTANT:  Sure, we can check your garden test word. |  Your garden test word is tamarind, V.
HINDSIGHT RECALL (bank hermes):

TRANSCRIPT (fragments joined per speaker):
2026-10-09T21:54:56.596Z user:  What's my garden test word
2026-10-09T21:54:58.696Z assistant:  Sure, we can check your garden test word.
2026-10-09T21:55:05.695Z assistant:  Your garden test word is tamarind, V.
JOBS: [
 {
  "state": "completed",
  "run_id": "run_89477c6d05fd4ddda664e8afb96419af",
  "hermes_session": "voice-b66b3fbd-63d0-47ee-9c08-026778fd3b1e-live_EXCqAspJmDUHkXZub5C7H",
  "result": "Your garden test word is tamarind, V.",
  "hermes": {
   "run": "run_89477c6d05fd4ddda664e8afb96419af",
   "session": "voice-b66b3fbd-63d0-47ee-9c08-026778fd3b1e-live_EXCqAspJmDUHkXZub5C7H",
   "status": "completed",
   "seconds": 3.4,
   "inputTokens": 20563,
   "output": "Your garden test word is tamarind, V."
  }
 }
]

=== 3b PASS word "tamarind" spoken; answer: " Your garden test word is tamarind, V."
[cleanup] {"run":"fix3-3b-mv1hu4kt","testConversations":1,"hermesSessions":["voice-b66b3fbd-63d0-47ee-9c08-026778fd3b1e-live_EXCqAspJmDUHkXZub5C7H","20261009_214452_24341e"],"oneshotSessions":1,"voiceSaveDocuments":0,"memoriesFound":4,"bySource":{"hermes-session":2,"test-word":2},"invalidated":2,"prunedWithTheirSource":2,"stillValidPerSession":{"voice-b66b3fbd-63d0-47ee-9c08-026778fd3b1e-live_EXCqAspJmDUHkXZub5C7H":0,"20261009_214452_24341e":0},"retainsStillPending":0,"recallHitsForTestWords":{"tamarind":0},"preparedMemoryRefreshed":[],"hermesMemoryFileHits":[],"preparedMemoryHitsForTestWords":{"jarvis-voice-profile":[],"jarvis-voice-preferences":[],"jarvis-voice-current":[]}}
[isolation] owner conversation new fragments: 0

=== 3c PASS (limit 10000 ms)
SQL: SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND at>=? ORDER BY at,rowid
ARGS: ["live_EXCqAspJmDUHkXZub5C7H"]
[
 {
  "question": "What's my garden test word?",
  "latencyMs": 8547,
  "audioClockLatencyMs": 8800,
  "pass": true
 }
]

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix3-3b-1791582923691.json
EXIT 0
```

Hermes run `run_89477c6d05fd4ddda664e8afb96419af` answered from the memory recalled for the request, with no tool call: 3.4 s and 20,563 tokens. Baseline on the per-call build before the recall change (`fix3-3b-mv1gxre3`, word "pumpernickel"): `=== 3b PASS word "pumpernickel" spoken; answer: "Your garden test word is pumpernickel, V."`, at 10.3 s (3c FAIL then).

## 3c: Reasonable time (≤ 10 s) — PASS

The question ends at the end of its audio (`said.endedAt`, the same machine clock as `fragments.at`). This is earlier than the user fragment's own `at`, so it is the stricter measure. The answer starts at `fragments.at` of the first assistant fragment of the actual answer. For a handed-off question, that is the first assistant fragment after the result's `deliveries` row reached `injected`, so the "Looking that up" line is excluded. Query: `SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND at>=? ORDER BY at,rowid`.

3a questions (session `live_EXCe9Q7QuljTtwUI6lhcD`; the 3d follow-up is included too):

```
=== 3c PASS (limit 10000 ms)
SQL: SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND at>=? ORDER BY at,rowid
ARGS: ["live_EXCe9Q7QuljTtwUI6lhcD"]
[
 {
  "question": "What's my name?",
  "latencyMs": 355,
  "audioClockLatencyMs": 0,
  "pass": true
 },
 {
  "question": "What do you know about me?",
  "latencyMs": 693,
  "audioClockLatencyMs": 0,
  "pass": true
 },
 {
  "question": "Who is Teresa?",
  "latencyMs": 698,
  "audioClockLatencyMs": 0,
  "pass": true
 },
 {
  "question": "And what does she do?",
  "latencyMs": 5949,
  "audioClockLatencyMs": 7000,
  "pass": true
 },
 {
  "question": "What am I working on right now?",
  "latencyMs": 1793,
  "audioClockLatencyMs": 600,
  "pass": true
 }
]
```

3b question (session `live_EXCqAspJmDUHkXZub5C7H`): 8,547 ms (audio clock 8,800 ms), from the 3b output above.

| Question | ms to the answer |
| --- | --- |
| What's my name? | 355 |
| What do you know about me? | 693 |
| Who is Teresa? | 698 |
| What am I working on right now? | 1,793 |
| What's my garden test word? (3b) | 8,547 |
| And what does she do? (3d, handed off) | 5,949 |

Before the changes: 3b took 10,299 ms (FAIL), and the 3d follow-up took 21,299 / 12,439 / 11,897 ms on intermediate builds.

## 3d: Conversational — PASS

From the 3a run above:

```
2026-10-09T21:43:10.288Z user:  Who is Teresa
2026-10-09T21:43:11.688Z assistant:  Teresa is your spouse.
2026-10-09T21:43:24.989Z user:  And what does she do
2026-10-09T21:43:26.390Z assistant:  What does she do? I'll have a look.
2026-10-09T21:43:31.288Z assistant:  She handles CM Sheet approvals as one of seven financial reviewers, but I don't have her exact job title or employer noted.
```

It resolved "she" without asking, handed off, and answered from memory (`Teresa is one of seven financial reviewers`), saying plainly what memory doesn't hold. Baseline: `I don't have details on her work.` (no hand-off).

## 3e: Nothing hard-coded — PASS

Command (this fix's diff against 342edc0, plus the new untracked files, in code, prompts, tests, scripts and deploy):

```
$ for w in Teresa Vyente Ruffin Fontana Boston Dallas "Fort Worth" DFW Fresno Austin Youni 405network CommScope "CM Sheet" "charge-modification" Houston "acquisition dashboard" "financial reviewer" Microsoft; do n=$( (git diff 342edc0 -- src web scripts tests deploy; git ls-files --others --exclude-standard src web scripts tests deploy | xargs cat) | grep -c -i -- "$w"); echo "$w: $n"; done
Teresa: 0
Vyente: 0
Ruffin: 0
Fontana: 0
Boston: 0
Dallas: 0
Fort Worth: 0
DFW: 0
Fresno: 0
Austin: 0
Youni: 0
405network: 0
CommScope: 0
CM Sheet: 0
charge-modification: 0
Houston: 0
acquisition dashboard: 0
financial reviewer: 0
Microsoft: 0
```

The code test `3e: the Fix 3 diff adds none of the user's remembered facts to code` also passes. It takes every proper name from the live prepared memory and checks the lines this fix adds. A probe file holding one remembered name made it fail as expected, and the probe was then removed. The questions in `fix3.mjs` are read from the plan at run time. Its test words are random dictionary words, not facts about V. This evidence file quotes transcripts and recalls, which is what evidence is for. It is not code.

## Notes

- Restarts: before each of the five restarts, `SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','awaiting_permission')` returned `active 0`. Before each restart, the state DB was copied to `~/.local/state/jarvis-voice/state.sqlite.<UTC timestamp>`.
- Seen but outside Fix 3: in a new conversation with nothing to replay, the voice sometimes opens unasked ("Hey V. What's on your mind?", "Ready when you are."), and once it volunteered a prepared fact while a lookup ran. Fix 1's silent start covers V's own conversation, which always has history. Test conversations have none, so this shows up only in tests. No check here depends on it.
- Raw JSON for every run is in `logs/live-e2e/fix3-*.json` (git-ignored).
