# Realtime session budget (M0.T3)

The four numbers that bound every voice session, with their citations (per plan Sources index — note the ceilings live on the realtime how-to page, NOT the quotas page; verifier-confirmed):

| Constraint | Value | Source |
|---|---|---|
| Max session duration | **60 minutes** | [MS14] — "Realtime sessions have a maximum duration of 60 minutes" |
| Input context ceiling | **32,000 tokens** | [MS14] — "The Realtime API supports up to 32,000 input tokens and 4,096 output tokens" |
| Output ceiling per response | **4,096 tokens** | [MS14] |
| Deployment throughput | **10K TPM** (GlobalStandard, capacity 10) | [LIVE-4]; realtime has its own audio-token & concurrent-session rate limits [MS11] |

## What this means in practice

Observed burn from the live smoke test ([LIVE-1]): one 13-second spoken reply cost 390 total tokens (51 in / 339 out, 263 of them audio tokens). Scaling that observation:

- tokens per minute of active conversation ≈ 390 ÷ (13/60) ≈ **1,800 tokens/min** (estimate; includes both directions)
- **minutes/session budget = 10,000 TPM ÷ 1,800 tokens/min ≈ 5.5 concurrent active-minutes** — fine for one person talking (speech has silences; effective burn is lower), fatal for parallel sessions. Raise capacity before multi-session testing.
- The 32K input ceiling is the *conversation memory* of the mouth, not the brain: hermes holds the real history. Session rotation (M3.T3) resets the mouth's context at 50 minutes anyway — [MS14]'s 60-minute cap is the hard wall.
- Injected replies count against output (4,096 tokens ≈ ~3,000 words ≈ far longer than any sane spoken reply). Constraint honored by keeping hermes' voice replies conversational (M4 preamble instructs brevity).

## Rotation policy (feeds M3.T3)

Rotate at **50 minutes** (10-minute safety margin under the 60-minute cap [MS14]), only at a `response.done` boundary, preserving the ACP session so the brain never blinks [H3].
