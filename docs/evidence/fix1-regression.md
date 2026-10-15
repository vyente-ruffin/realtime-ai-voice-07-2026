# Fix 1 regression: silent connect (Oct 15, 2026)

Task: during Fix 6 testing, one call opened with "Welcome back. What do you want to talk about?" before the test speaker said anything (end of `docs/evidence/fix6.md`). Measure the Fix 1 silent-connect rule with 10 silent calls, find the cause of any early speech, fix it in our app only, and rerun.

**Result: baseline 1 of 10 spoke first. Two causes found, both quiet `session.thinking.append` updates the page sent into a call before the user spoke. After the fix: 0 of 10. fix1.mjs 1a–1f PASS. 7a PASS.**

## Method

- Harness: `scripts/live-e2e/fix1-silent.mjs [N] [label]`. Each call is its own `TestRun` (own test conversation, never V's; `cleanup.mjs` after each). One call at a time, and Chrome is closed after each. Headless Chrome uses fake media with a silent WAV. The call connects, stays silent 30 s, then ends.
- Pass/fail per call: the new session has any `fragments` row with `role='assistant'` before its first `role='user'` row. Measured from `~/.local/state/jarvis-voice/state.sqlite`, opened read-only. Deliveries for the session are listed too. Every call here is fresh (no reconnect), so a "We got cut off" line would also count as a failure. None appeared.
- Independent recount: `node scripts/live-e2e/fix1-silent-recount.mjs <results.json>` re-queries every session from the database.
- Cause evidence: the page's own event log (`window.__voiceLabEvents`), kept in each results JSON as `sent`. It records every `session.thinking.appended` acknowledgment and `memory.context.held` (added here). Times are ms after `session.started`.

## Baseline: 1 of 10 spoke first

Command: `node scripts/live-e2e/fix1-silent.mjs 10 baseline` (service on commit 64fd036; log `logs/live-e2e/fix1-silent-baseline.log`)

```
[isolation] owner conversation new fragments: 0
=== baseline call 1: conversation 8f990530-ada3-4acd-807c-3a658761204a, session live_EZMRCbEGfNzCIVncUeuMA
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMRCbEGfNzCIVncUeuMA]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMRCbEGfNzCIVncUeuMA] -> []
call 1: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 2: conversation 9a3bfda9-0143-492a-ad10-10c383b8a082, session live_EZMRpkIl3gr2GafhGWfHG
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMRpkIl3gr2GafhGWfHG]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMRpkIl3gr2GafhGWfHG] -> []
call 2: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 3: conversation 72b8c53c-b791-4603-bf6d-eae6aa2e1350, session live_EZMSRhN9mNSBcYra1xJKv
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMSRhN9mNSBcYra1xJKv]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMSRhN9mNSBcYra1xJKv] -> []
call 3: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 4: conversation 43e89dcf-d891-4a85-b042-79265f709682, session live_EZMT3DEgoYlulEfQCvao6
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMT3DEgoYlulEfQCvao6]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMT3DEgoYlulEfQCvao6] -> []
call 4: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 5: conversation 03ac232c-7978-45ab-8758-e344f331d6f1, session live_EZMTfZii6wS4yZtOYqmPs
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMTfZii6wS4yZtOYqmPs]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMTfZii6wS4yZtOYqmPs] -> []
call 5: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 6: conversation fa636a69-b24f-4696-9e94-018493f55a4e, session live_EZMUH5WZFuDAoTI6419oo
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMUH5WZFuDAoTI6419oo]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMUH5WZFuDAoTI6419oo] -> []
call 6: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 7: conversation 6055ab80-418a-43b0-b10d-d7b33a673911, session live_EZMUs7yU36CsOXxkzxK1Z
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMUs7yU36CsOXxkzxK1Z]
  2026-10-15T20:38:11.538Z assistant " Okay."
  2026-10-15T20:38:12.238Z assistant " Understood"
  2026-10-15T20:38:12.239Z assistant "."
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMUs7yU36CsOXxkzxK1Z] -> []
call 7: SPOKE FIRST (assistant fragments before first user fragment: 3)
[isolation] owner conversation new fragments: 0
=== baseline call 8: conversation 7ee3190d-76ad-4e1a-be19-6274f7ddeb6f, session live_EZMVUY21AGzNtKGYLArpa
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMVUY21AGzNtKGYLArpa]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMVUY21AGzNtKGYLArpa] -> []
call 8: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 9: conversation 513c1653-53a7-4cf3-993a-db9906ca5a20, session live_EZMW6QW7Tq3obEX4ruMQE
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMW6QW7Tq3obEX4ruMQE]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMW6QW7Tq3obEX4ruMQE] -> []
call 9: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== baseline call 10: conversation 78442a07-7026-48a7-a0f8-9c13f50f10a9, session live_EZMWhSt0rY2TUO1SrC5GF
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMWhSt0rY2TUO1SrC5GF]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMWhSt0rY2TUO1SrC5GF] -> []
call 10: silent (assistant fragments before first user fragment: 0)
SUMMARY baseline: 1 of 10 calls spoke first (0 errors). Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix1-silent-baseline-1792096816100.json
```

Recount from the database:

```
SQL: SELECT (SELECT COUNT(*) FROM fragments WHERE session=? AND role='assistant' AND at < COALESCE((SELECT MIN(at) FROM fragments WHERE session=? AND role='user'), 9e15)) AS assistant_before_user, (SELECT COUNT(*) FROM fragments WHERE session=? AND role='user') AS user_fragments, (SELECT COUNT(*) FROM deliveries WHERE session=?) AS deliveries
1 live_EZMRCbEGfNzCIVncUeuMA {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
2 live_EZMRpkIl3gr2GafhGWfHG {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
3 live_EZMSRhN9mNSBcYra1xJKv {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
4 live_EZMT3DEgoYlulEfQCvao6 {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
5 live_EZMTfZii6wS4yZtOYqmPs {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
6 live_EZMUH5WZFuDAoTI6419oo {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
7 live_EZMUs7yU36CsOXxkzxK1Z {"assistant_before_user":3,"user_fragments":0,"deliveries":0}
8 live_EZMVUY21AGzNtKGYLArpa {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
9 live_EZMW6QW7Tq3obEX4ruMQE {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
10 live_EZMWhSt0rY2TUO1SrC5GF {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
calls that spoke first: 1 of 10
```

## Cause

**Cause 1 (baseline call 7): a prepared-memory refresh pushed into a silent call.** The server refreshes the Hindsight prepared memories every 60 s (`src/live/server.js` `refreshTick`). When a section changes, it publishes `memory.context` over SSE. The page (`web/memory-context.js`) at once sent each changed section as `session.thinking.append`. In call 7, six memory chunks went out at +23.3–23.5 s. The model said "Okay. Understood." at +23.7 s, with no user speech, no delivery and no history (a fresh test conversation). Page events for call 7:

```
[[-1308,"connection.audio_context"],[-12,"session.thinking.appended"],[-12,"clock.context.accepted"],[12879,"session.thinking.appended"],[12879,"clock.context.accepted"],[23310,"session.thinking.appended"],[23322,"session.thinking.appended"],[23346,"session.thinking.appended"],[23346,"memory.context.accepted"],[23369,"session.thinking.appended"],[23405,"session.thinking.appended"],[23434,"session.thinking.appended"],[23459,"session.thinking.appended"],[23459,"memory.context.accepted"]]
```

**Cause 2 (found in the first rerun, call 10): the call-start clock snapshot.** With cause 1 fixed, rerun `after2` still had 1 of 10 speak first: "So. Go ahead, what's on your mind?" at +483 ms. The only thing the app sent that call was the browser-clock `session.thinking.append` at −1 ms (`clockContext.start()` on channel open / `session.started`). This matches the Fix 6 call ("Welcome back…" about 1.1 s after `session.started`, with no delivery in its audit rows). The session prompt already carries the start time ("Current local time at this prompt's creation"), so this snapshot added nothing at call start.

```
first assistant fragment at +483 ms; page events: [[-1423,"connection.audio_context"],[-1,"session.thinking.appended"],[-1,"clock.context.accepted"]]
```

Not the cause: the instructions already say to stay silent at call start (`src/live/policy.js` turn-taking reminder, unchanged). History replay was not the cause either: each test conversation is fresh, and its replayed `input` is empty. No delivery was involved: every session has 0 `deliveries` rows (recount above).

## Fix (our app only; instructions untouched)

- `web/memory-context.js`: a new `holdUntilUser` option. Changed sections wait in `pending` and are sent only from `userSpoke()`, which runs while the user is speaking. Unchanged sections are still dropped at once. `ClockContext` passes the option through (`web/clock-context.js`). Default behaviour without the option is unchanged.
- `web/live.js`: both `memoryContext` and `clockContext` use `{ holdUntilUser: true }`. On every user input-transcript delta, `memoryContext.userSpoke()` and `clockContext.userSpoke()` run. So the newest facts and clock reach the model while the user is talking, before it answers. Fix 4 already uses this approach for status (resent on user speech, because a timed resend made the model announce progress). The page also records `memory.context.held` when a changed section is waiting (evidence only).
- `src/live/memory.js`: each memory section's text now also says "Quiet context, not a request to speak: never reply to or acknowledge this update."
- Not changed: Fix 5 and Fix 7 instructions, deliveries, and the Fix 7 cut-off offer, which is commentary and is still sent at once (7a below).
- Tests: `tests/live/silent-connect.test.mjs` (8 tests). They cover: no memory send before the user speaks; release on speech, then hold again; re-hold on a new session or reconnect; unchanged sections not counted as held; the clock held at call start and through minute changes, then sending the newest minute on speech; the clock without the option unchanged; the page wiring; and the memory-section wording.

## After: 0 of 10 spoke first

The first rerun (`after`, memory hold only, a counting bug in the held marker) was 0/10. Its recount:

```
SQL: SELECT (SELECT COUNT(*) FROM fragments WHERE session=? AND role='assistant' AND at < COALESCE((SELECT MIN(at) FROM fragments WHERE session=? AND role='user'), 9e15)) AS assistant_before_user, (SELECT COUNT(*) FROM fragments WHERE session=? AND role='user') AS user_fragments, (SELECT COUNT(*) FROM deliveries WHERE session=?) AS deliveries
1 live_EZMZdgypeyPpgFu5IpaV8 {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
2 live_EZMaFOT5A6M3rRrQ7IUMP {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
3 live_EZMar4HymrGNf6yUCRY3k {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
4 live_EZMbSNqa4xav1ciNP6SLg {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
5 live_EZMc4F65NSIfcMxLdwviL {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
6 live_EZMcfQLjo73zDuFnj5bKf {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
7 live_EZMdHKOuOzsJptmXJFScD {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
8 live_EZMdtBC31RDJ2xMeky3jt {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
9 live_EZMeVCjHPrEcAdIq7taAW {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
10 live_EZMf680I4U0LrMv8ue5JJ {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
calls that spoke first: 0 of 10
```

Rerun `after2` (memory hold with the marker fixed, clock not yet held) was **1/10**, which exposed cause 2:

```
[isolation] owner conversation new fragments: 0
=== after2 call 1: conversation ce8f44da-8354-40d4-b2f8-6e95415930b6, session live_EZMgGRbX0x6yDJn20NsRJ
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMgGRbX0x6yDJn20NsRJ]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMgGRbX0x6yDJn20NsRJ] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=2
call 1: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 2: conversation 17339dbe-a6f9-4340-9db8-f6da1bf44bc4, session live_EZMgsDBSasXrEBaOl4tNV
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMgsDBSasXrEBaOl4tNV]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMgsDBSasXrEBaOl4tNV] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=1
call 2: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 3: conversation 43eec4d5-8f1e-46ad-b86a-14d8827907c7, session live_EZMhThv8KALJwjE4KoV1L
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMhThv8KALJwjE4KoV1L]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMhThv8KALJwjE4KoV1L] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=2
call 3: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 4: conversation 4b528947-4cc1-4693-9806-14b97127a580, session live_EZMi5Edj5qUlobo5ePHNd
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMi5Edj5qUlobo5ePHNd]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMi5Edj5qUlobo5ePHNd] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=1
call 4: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 5: conversation 20a604d3-6bc6-45b6-8d0a-7a231942ff38, session live_EZMihaqerLeAx1ay1q780
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMihaqerLeAx1ay1q780]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMihaqerLeAx1ay1q780] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=1
call 5: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 6: conversation eb5d2a80-6314-4fd1-b918-8dd2a802bc6f, session live_EZMjIh71E2w0ZHl61sGXb
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMjIh71E2w0ZHl61sGXb]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMjIh71E2w0ZHl61sGXb] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=2
call 6: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 7: conversation bb623d7f-31f6-4748-9acc-b3dc985c2eb2, session live_EZMjuZFneosjKBPdsvOit
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMjuZFneosjKBPdsvOit]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMjuZFneosjKBPdsvOit] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=1
call 7: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 8: conversation 0227ae05-3b77-4e7b-a33c-7c55c7874e30, session live_EZMkW0AqXiSrmbiXRApFE
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMkW0AqXiSrmbiXRApFE]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMkW0AqXiSrmbiXRApFE] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=2
call 8: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 9: conversation d55697e1-a5a0-4404-8283-2c40aecf0fb1, session live_EZMl7EGuZGbnIxbL4WIGW
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMl7EGuZGbnIxbL4WIGW]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMl7EGuZGbnIxbL4WIGW] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=2
call 9: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after2 call 10: conversation 138f5075-0f21-44bb-bc55-0725c9d1500f, session live_EZMljEPYYIFBZXs3kUfIj
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMljEPYYIFBZXs3kUfIj]
  2026-10-15T20:55:12.646Z assistant "So"
  2026-10-15T20:55:14.046Z assistant " Go ahead"
  2026-10-15T20:55:14.048Z assistant ", what's"
  2026-10-15T20:55:14.746Z assistant " on"
  2026-10-15T20:55:14.750Z assistant " your mind"
  2026-10-15T20:55:14.751Z assistant "?"
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMljEPYYIFBZXs3kUfIj] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=1
call 10: SPOKE FIRST (assistant fragments before first user fragment: 6)
SUMMARY after2: 1 of 10 calls spoke first (0 errors). Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix1-silent-after2-1792097747405.json
```

```
SQL: SELECT (SELECT COUNT(*) FROM fragments WHERE session=? AND role='assistant' AND at < COALESCE((SELECT MIN(at) FROM fragments WHERE session=? AND role='user'), 9e15)) AS assistant_before_user, (SELECT COUNT(*) FROM fragments WHERE session=? AND role='user') AS user_fragments, (SELECT COUNT(*) FROM deliveries WHERE session=?) AS deliveries
1 live_EZMgGRbX0x6yDJn20NsRJ {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
2 live_EZMgsDBSasXrEBaOl4tNV {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
3 live_EZMhThv8KALJwjE4KoV1L {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
4 live_EZMi5Edj5qUlobo5ePHNd {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
5 live_EZMihaqerLeAx1ay1q780 {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
6 live_EZMjIh71E2w0ZHl61sGXb {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
7 live_EZMjuZFneosjKBPdsvOit {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
8 live_EZMkW0AqXiSrmbiXRApFE {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
9 live_EZMl7EGuZGbnIxbL4WIGW {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
10 live_EZMljEPYYIFBZXs3kUfIj {"assistant_before_user":6,"user_fragments":0,"deliveries":0}
calls that spoke first: 1 of 10
```

**Final rerun `after3` (both holds; service restarted on this code, buildId beab9b63ef41eadd):**

Command: `node scripts/live-e2e/fix1-silent.mjs 10 after3` (log `logs/live-e2e/fix1-silent-after3.log`)

```
[isolation] owner conversation new fragments: 0
=== after3 call 1: conversation 990bbdae-8521-4245-9c6e-166934605446, session live_EZMnDHPTzVJQ0FCsBhljs
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMnDHPTzVJQ0FCsBhljs]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMnDHPTzVJQ0FCsBhljs] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 1: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 2: conversation eb930a3e-42e2-4661-931c-6db6b4f2332e, session live_EZMnpxCgFHkWOULyRVdg6
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMnpxCgFHkWOULyRVdg6]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMnpxCgFHkWOULyRVdg6] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 2: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 3: conversation 1b7ad9d2-c8ea-43fc-9ac1-f20a6ddf51aa, session live_EZMoRyPF9lQtwldcaWlmt
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMoRyPF9lQtwldcaWlmt]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMoRyPF9lQtwldcaWlmt] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 3: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 4: conversation 7b6d84f4-4db6-4a91-a28b-77ef84608fe5, session live_EZMp4qSsAU3maUZ4A4JqV
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMp4qSsAU3maUZ4A4JqV]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMp4qSsAU3maUZ4A4JqV] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 4: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 5: conversation 24e62f59-9468-40d4-8ab4-0273191343e2, session live_EZMpfmAn35wiW6MsFeI99
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMpfmAn35wiW6MsFeI99]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMpfmAn35wiW6MsFeI99] -> []
page events: memory.context.held=1 memory.context.accepted=0 session.thinking.appended=0
call 5: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 6: conversation 3b1181eb-fa48-4329-a763-0a11c51b1be7, session live_EZMqHAmttITZ9s6J7fr1f
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMqHAmttITZ9s6J7fr1f]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMqHAmttITZ9s6J7fr1f] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 6: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 7: conversation 6ceb7b89-3e1c-4c6e-b524-efc2b1bc8831, session live_EZMqtvODyCEnHYDFl2MLr
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMqtvODyCEnHYDFl2MLr]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMqtvODyCEnHYDFl2MLr] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 7: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 8: conversation a8c9710f-f475-4578-bea9-6968c8bf7668, session live_EZMrVB5KGK52sgsPuOY3d
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMrVB5KGK52sgsPuOY3d]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMrVB5KGK52sgsPuOY3d] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 8: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 9: conversation 4425125f-ae9c-480f-a479-3e4211c1cfea, session live_EZMs6QdbOYIHkXyP2ffmJ
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMs6QdbOYIHkXyP2ffmJ]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMs6QdbOYIHkXyP2ffmJ] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 9: silent (assistant fragments before first user fragment: 0)
[isolation] owner conversation new fragments: 0
=== after3 call 10: conversation f86ecb4e-101c-47d2-8aa1-6043680ecb36, session live_EZMsiSCW8bjXaVgI8CVrz
SQL: SELECT session,role,text,at FROM fragments WHERE session=? ORDER BY at,rowid [live_EZMsiSCW8bjXaVgI8CVrz]
  (no rows)
SQL: SELECT job,state,session,updated FROM deliveries WHERE session=? [live_EZMsiSCW8bjXaVgI8CVrz] -> []
page events: memory.context.held=0 memory.context.accepted=0 session.thinking.appended=0
call 10: silent (assistant fragments before first user fragment: 0)
SUMMARY after3: 0 of 10 calls spoke first (0 errors). Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix1-silent-after3-1792098180877.json
```

Recount from the database:

```
SQL: SELECT (SELECT COUNT(*) FROM fragments WHERE session=? AND role='assistant' AND at < COALESCE((SELECT MIN(at) FROM fragments WHERE session=? AND role='user'), 9e15)) AS assistant_before_user, (SELECT COUNT(*) FROM fragments WHERE session=? AND role='user') AS user_fragments, (SELECT COUNT(*) FROM deliveries WHERE session=?) AS deliveries
1 live_EZMnDHPTzVJQ0FCsBhljs {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
2 live_EZMnpxCgFHkWOULyRVdg6 {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
3 live_EZMoRyPF9lQtwldcaWlmt {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
4 live_EZMp4qSsAU3maUZ4A4JqV {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
5 live_EZMpfmAn35wiW6MsFeI99 {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
6 live_EZMqHAmttITZ9s6J7fr1f {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
7 live_EZMqtvODyCEnHYDFl2MLr {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
8 live_EZMrVB5KGK52sgsPuOY3d {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
9 live_EZMs6QdbOYIHkXyP2ffmJ {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
10 live_EZMsiSCW8bjXaVgI8CVrz {"assistant_before_user":0,"user_fragments":0,"deliveries":0}
calls that spoke first: 0 of 10
```

Page events per call (no quiet update reached the model during the 30 s silence; call 5 held a real changed memory section and stayed silent):

```
1 [[-1437,"connection.audio_context"]]
2 [[-1440,"connection.audio_context"]]
3 [[-1902,"connection.audio_context"]]
4 [[-1474,"connection.audio_context"]]
5 [[-1412,"connection.audio_context"],[23311,"memory.context.held"]]
6 [[-1399,"connection.audio_context"]]
7 [[-1469,"connection.audio_context"]]
8 [[-1504,"connection.audio_context"]]
9 [[-1415,"connection.audio_context"]]
10 [[-1439,"connection.audio_context"]]
```

Every run printed `[isolation] owner conversation new fragments: 0` (10 of 10 lines in each log).

## Fix 1 rerun: 1a–1f PASS

Command: `node scripts/live-e2e/fix1.mjs` (log `logs/live-e2e/fix1-regression-fix1.log`, cleanup and logger lines removed below)

```
{"timestamp":"2026-10-15T21:03:21.557Z","level":"info","logger":"live-e2e.fix1","message":"job A finished","state":"completed"}
{"timestamp":"2026-10-15T21:03:21.557Z","level":"info","logger":"live-e2e.fix1","message":"waiting 5 minutes before the next call","until":"2026-10-15T21:08:21.557Z"}
{"timestamp":"2026-10-15T21:09:23.405Z","level":"info","logger":"live-e2e.fix1","message":"check 1a: PASS","note":"deliveries for earlier-call jobs=0; assistant turns in first 60 s=1; waiting lines=1"}

=== 1a PASS deliveries for earlier-call jobs=0; assistant turns in first 60 s=1; waiting lines=1
SQL: SELECT d.job,d.state,d.session,d.updated,j.session AS job_session FROM deliveries d JOIN jobs j ON j.id=d.job WHERE d.session=? AND j.session<>?
ARGS: ["live_EZMyULSsPwPKcwwamyXb3","live_EZMyULSsPwPKcwwamyXb3"]
ROWS: []
{"timestamp":"2026-10-15T21:09:40.281Z","level":"info","logger":"live-e2e.fix1","message":"check 1b: PASS","note":"job A key word \"Schlegel's asity\"; assistant after yes: \" Okay.  The test bird is Schlegel's asity. It was seen at the east pond.  The test bird is Schlegel's asity. It was seen at the east pond.\""}

=== 1b PASS job A key word "Schlegel's asity"; assistant after yes: " Okay.  The test bird is Schlegel's asity. It was seen at the east pond.  The test bird is Schlegel's asity. It was seen at the east pond."
SQL: SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments f WHERE f.session=? AND f.role='user' AND f.at>=?) AS yes_fragment_at FROM deliveries d WHERE d.job=?
ARGS: ["live_EZMyULSsPwPKcwwamyXb3",1792098503397,"04b94987-eec1-4bb0-ba43-1b4b04f9bc35"]
ROWS: [
 {
  "job": "04b94987-eec1-4bb0-ba43-1b4b04f9bc35",
  "state": "injected",
  "session": "live_EZMyULSsPwPKcwwamyXb3",
  "updated": 1792098567843,
  "yes_fragment_at": 1792098565483
 }
]
{"timestamp":"2026-10-15T21:10:44.288Z","level":"info","logger":"live-e2e.fix1","message":"check 1c: PASS","note":"stop fragment start_ms=32000; assistant fragments starting >1 s after stop=0 (received in 30 s, incl. tail=0); new deliveries in 30 s=0; second result final and waiting=true"}

=== 1c PASS stop fragment start_ms=32000; assistant fragments starting >1 s after stop=0 (received in 30 s, incl. tail=0); new deliveries in 30 s=0; second result final and waiting=true
SQL: SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND start_ms>?+1000 AND start_ms<=?+31000;
SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<=?;
SELECT job,state,session,updated FROM deliveries WHERE session=? AND updated>? AND updated<=?;
SELECT id,state,updated FROM jobs WHERE id IN (?,?)
ARGS: ["live_EZMznBdTdGXD3iTDszxSl",32000,1792098614059,1792098644059,"9ac8b799-17f8-4a5e-b0ed-2f9c964559a5","4e537b4d-7400-48c3-804c-e5abbe4d22fe"]
ROWS: {
 "assistant": [],
 "received": [],
 "deliveries": [],
 "waiting": [
  {
   "id": "4e537b4d-7400-48c3-804c-e5abbe4d22fe",
   "state": "completed",
   "updated": 1792098597036
  },
  {
   "id": "9ac8b799-17f8-4a5e-b0ed-2f9c964559a5",
   "state": "completed",
   "updated": 1792098593924
  }
 ]
}
{"timestamp":"2026-10-15T21:11:13.185Z","level":"info","logger":"live-e2e.fix1","message":"check 1d: PASS","note":"question fragment at 1792098645563"}

=== 1d PASS question fragment at 1792098645563
SQL: SELECT d.job,d.state,d.session,d.updated,(SELECT MIN(at) FROM fragments WHERE session=? AND role='assistant' AND at>?) AS answer_at,(SELECT group_concat(text,'') FROM (SELECT text FROM fragments WHERE session=? AND role='assistant' AND at>? AND at<d.updated ORDER BY at,rowid)) AS answer_text FROM deliveries d WHERE d.job=?
ARGS: ["live_EZMznBdTdGXD3iTDszxSl",1792098645563,"live_EZMznBdTdGXD3iTDszxSl",1792098645563,"4e537b4d-7400-48c3-804c-e5abbe4d22fe"]
ROWS: [
 {
  "job": "4e537b4d-7400-48c3-804c-e5abbe4d22fe",
  "state": "injected",
  "session": "live_EZMznBdTdGXD3iTDszxSl",
  "updated": 1792098657844,
  "answer_at": 1792098645566,
  "answer_text": " of Japan?Tokyo.Paris."
 }
]
{"timestamp":"2026-10-15T21:11:15.281Z","level":"info","logger":"live-e2e.fix1","message":"check 1e: PASS","note":""}

=== 1e PASS 
SQL: SELECT COUNT(*) AS n FROM jobs j LEFT JOIN deliveries d ON d.job=j.id WHERE j.state IN ('completed','failed','cancelled','interrupted') AND j.updated<? AND (d.state IS NULL OR d.state='available')
ARGS: [1791529200000]
ROWS: [
 {
  "n": 0
 }
]
{"timestamp":"2026-10-15T21:11:15.333Z","level":"info","logger":"live-e2e.fix1","message":"check 1f: PASS","note":"overlapping user fragments=5"}

=== 1f PASS overlapping user fragments=5
SQL: SELECT u.session,u.text,u.at,u.start_ms,u.end_ms,d.job,d.state,d.updated FROM fragments u JOIN deliveries d ON d.session=u.session AND d.updated>=u.at AND d.updated<u.at+10000 WHERE u.role='user' AND u.session IN (?,?,?) AND EXISTS (SELECT 1 FROM fragments a WHERE a.session=u.session AND a.role='assistant' AND a.start_ms<u.end_ms AND a.end_ms>u.start_ms)
ARGS: ["live_EZMtQeIXYYO23pRJSVb9N","live_EZMyULSsPwPKcwwamyXb3","live_EZMznBdTdGXD3iTDszxSl"]
ROWS: []

Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix1-1792098675334.json
[isolation] owner conversation new fragments: 0
```

## Fix 7 rerun: 7a PASS (1 run)

Command: `node scripts/live-e2e/fix7.mjs 1` (log `logs/live-e2e/fix1-regression-fix7.log`; long lines cut at 300 characters)

```

=== run 1: test run fix7-mva1cuea, conversation d1c8d4f0-4f71-4c67-b671-69a08d0539c5, session live_EZN3MlJLKoXyYSE3a1Bbv
dropped at 1792098821523 (2008 ms into the answer); reconnected session live_EZN3f8dKraXVNi9La37UF at 1792098824073
SQL: SELECT id,session,state,result,created,updated FROM jobs WHERE id=? [3126e29d-4c97-4183-bb75-ff770a2d9f63]
{
 "id": "3126e29d-4c97-4183-bb75-ff770a2d9f63",
 "session": "live_EZN3MlJLKoXyYSE3a1Bbv",
 "state": "completed",
 "result": "The harbor bird is the Kerguelen tern. This spring, the lighthouse keeper counted seventeen nests. Nine lay beside the old stone wall. Each morning, she marked her notebook with blue ink. A fierce storm scattered feathers across her doorstep. She named the busiest nesting patch Lantern C
 "created": 1792098808882,
 "updated": 1792098819001
}
--- dropped session s1 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZN3MlJLKoXyYSE3a1Bbv])
1792098808880 user      [1792098808876-1792098808876] "Automated voice test for Hermes. Choose one random uncommon sea bird species yourself. Then write six short plain sentences about a lighthouse keeper counting that bird's nests this spring, with made-up numbers and details. The first sentence mu
1792098809663 assistant [3400-3600] "Alright."
1792098810363 assistant [4000-4200] " Handing"
1792098811065 assistant [4400-4600] " that"
1792098811070 assistant [4600-4800] " off"
1792098811075 assistant [4800-5000] " to Hermes"
1792098811764 assistant [5200-5400] " now."
1792098820163 assistant [13400-13600] "The harbor"
1792098820168 assistant [13600-13800] " bird"
1792098820168 assistant [13800-14000] " is the"
1792098820169 assistant [14000-14200] " Kerg"
1792098820863 assistant [14200-14400] "uelen"
1792098820864 assistant [14600-14800] " tern."
1792098821562 assistant [15000-15200] " This"
1792098821564 assistant [15200-15400] " spring,"
--- reconnected session s2 transcript (SQL: SELECT session,role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid [live_EZN3f8dKraXVNi9La37UF])
1792098826462 assistant [1800-2000] "We got"
1792098826465 assistant [2000-2200] " cut off"
1792098827162 assistant [2200-2400] "."
1792098827165 assistant [2400-2600] " Want"
1792098827166 assistant [2600-2800] " me to"
1792098827166 assistant [2800-3000] " finish"
1792098827862 assistant [3200-3400] " what I"
1792098827865 assistant [3400-3600] " was saying"
1792098828563 assistant [3600-3800] "?"
1792098850962 user      [26000-26200] " Yes"
1792098852362 assistant [27400-27600] " Okay."
1792098852364 assistant [27800-28000] " The harbor"
1792098853062 assistant [28200-28400] " bird"
1792098853064 assistant [28400-28600] " is"
1792098853065 assistant [28600-28800] " the"
1792098853065 assistant [28800-29000] " Kerg"
1792098853065 assistant [29000-29200] "uelen"
1792098853066 assistant [29200-29400] " tern."
1792098853762 assistant [29800-30000] " This"
1792098853764 assistant [30000-30200] " spring,"
1792098853764 assistant [30400-30600] " the"
1792098853765 assistant [30600-30800] " lighthouse"
1792098854462 assistant [30800-31000] " keeper"
1792098854463 assistant [31200-31400] " counted"
1792098855162 assistant [31600-31800] " seventeen"
1792098855163 assistant [32000-32200] " nests."
1792098855862 assistant [32600-32800] " Nine"
1792098856563 assistant [33000-33200] " lay"
1792098856566 assistant [33200-33400] " beside"
1792098856567 assistant [33600-33800] " the"
1792098857264 assistant [33800-34000] " old"
1792098857265 assistant [34000-34200] " stone"
1792098857266 assistant [34200-34400] " wall."
1792098857963 assistant [34800-35000] " Each"
1792098858662 assistant [35200-35400] " morning,"
1792098858666 assistant [35600-35800] " she"
1792098859364 assistant [35800-36000] " marked"
1792098859365 assistant [36000-36200] " her"
1792098859366 assistant [36200-36400] " notebook"
1792098859366 assistant [36400-36600] " with"
1792098860062 assistant [36600-36800] " blue"
1792098860064 assistant [36800-37000] " ink."
1792098860762 assistant [37400-37600] " A"
1792098860764 assistant [37600-37800] " fierce"
1792098861462 assistant [38000-38200] " storm"
1792098861465 assistant [38400-38600] " scattered"
1792098862163 assistant [38800-39000] " feathers"
1792098862865 assistant [39200-39400] " across"
1792098862867 assistant [39600-39800] " her"
1792098862868 assistant [39800-40000] " doorstep."
1792098863563 assistant [40400-40600] " She"
1792098864264 assistant [40800-41000] " named"
1792098864265 assistant [41000-41200] " the busiest"
1792098864963 assistant [41400-41600] " nesting"
1792098864964 assistant [41800-42000] " patch"
1792098864964 assistant [42000-42200] " Lantern"
1792098865663 assistant [42400-42600] " Cove."
SQL: SELECT job,state,session,event,updated FROM deliveries WHERE job=? [3126e29d-4c97-4183-bb75-ff770a2d9f63]
{"job":"3126e29d-4c97-4183-bb75-ff770a2d9f63","state":"injected","session":"live_EZN3f8dKraXVNi9La37UF","event":"result_1f9760d0-c26c-43e4-8bbb-c75f0253555f","updated":1792098851746}
SQL: SELECT id,delegation,created,substr(result,1,80) AS result FROM jobs WHERE conversation=? AND session=? [d1c8d4f0-4f71-4c67-b671-69a08d0539c5, live_EZN3f8dKraXVNi9La37UF]
[]
SQL: SELECT kind,payload,at FROM audit WHERE conversation=? AND kind IN (...) [d1c8d4f0-4f71-4c67-b671-69a08d0539c5]
[{"kind":"session.cut_off","payload":"{\"session\":\"live_EZN3MlJLKoXyYSE3a1Bbv\",\"job\":\"3126e29d-4c97-4183-bb75-ff770a2d9f63\"}","at":1792098822724},{"kind":"result.cut_off_offered","payload":"{\"session\":\"live_EZN3f8dKraXVNi9La37UF\",\"at\":1792098825661}","at":1792098825663},{"kind":"deliver
7a run 1: PASS {"pass":true,"silent":false,"offerOnly":true,"first":"We got cut off. Want me to finish what I was saying?","turns":1,"resumed":[]}
7b run 1: PASS {"pass":true,"coverage":1,"hasKey":true,"redelivered":true,"earlyWords":0,"repeats":1,"rerunJobs":0,"missing":[]}
[isolation] owner conversation new fragments: 0

SUMMARY 7a 1/1 PASS, 7b 1/1 PASS. Results: /home/localadmin/homelab/realtime-ai-voice-memory/logs/live-e2e/fix7-1792098873402.json
```

The reconnected session's only unprompted line is the single "We got cut off. Want me to finish what I was saying?" offer, so the cut-off offer is still sent at once and is not held.

## Tests

`npm run -s test:live`: 153 pass, 0 fail (145 earlier + 8 new). The final run is pasted at the end of this file.

## Summary

| Check | Result | Evidence |
| --- | --- | --- |
| Baseline | 1/10 spoke first | call 7 "Okay. Understood." at +23.7 s after a memory refresh push |
| Cause | found | quiet memory refresh (call 7) and the call-start clock snapshot (after2 call 10), sent before the user spoke |
| After | PASS 0/10 | after3 recount: assistant_before_user=0 in all 10 sessions |
| 1a–1f | PASS | fix1.mjs: all six `=== 1x PASS` |
| 7a | PASS | first line in the new session is the single cut-off offer |

### Final `npm run -s test:live` (exit=0)

```
✔ a silent close flushes final stats and reason under its original call/session (8.581762ms)
✔ oversized or mismatched sections are rejected, never silently cut into partial facts (49.495585ms)
✔ real browser saves silent-close evidence, current zone, periodic quality and unload beacon (10659.700174ms)
✔ 7a: after a drop the reconnected session is silent, then offers to finish exactly once (2.215952ms)
✔ silent call: a memory refresh before the user speaks is not sent (3.130194ms)
✔ the held refresh goes out once the user speaks, then the next waits again (1.475736ms)
✔ an unchanged section is not counted as held (0.263191ms)
✔ a new session (reconnect included) holds again until the user speaks (0.272916ms)
✔ call start: the clock is held until the user speaks, then sends the newest minute (0.681474ms)
✔ each memory section says it is quiet context, not a cue to speak (1.030691ms)
ℹ tests 153
ℹ suites 0
ℹ pass 153
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13386.129501
```
