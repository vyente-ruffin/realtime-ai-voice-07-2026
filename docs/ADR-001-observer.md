# ADR-001 — Mouth hardening: `webrtcfilter=on` and the server-side observer

**Status:** NO-GO on the filter as a standalone change. Observer refactor deferred, pending owner scope approval.
**Date:** 2026-07-26 · **Milestone:** M5.T2 · **Decides:** plan gate M5.T2#4

## Context

M5.T2 proposed two hardening steps:

1. Add `webrtcfilter=on` to the `/realtime/calls` URL so the browser receives only a
   restricted event set and "prompt instructions stay private" [MS10].
2. Evaluate the server-side WebSocket observer — proxy the SDP negotiation, parse the
   `Location` header, and connect `wss://…/openai/v1/realtime?call_id=…`, which "can
   record the WebRTC call and even control it by issuing session.update events and
   other commands" [MS9].

The motivation is real: today the browser holds the say-exactly instructions, so a
compromised page could read what we tell the mouth to say.

## What the filter actually allows

Verbatim from the WebRTC how-to [MS10], the complete set delivered to the browser
with the filter on:

```
input_audio_buffer.speech_started      conversation.item.added
input_audio_buffer.speech_stopped      conversation.item.created
output_audio_buffer.started            response.output_text.delta
output_audio_buffer.stopped            response.output_text.done
conversation.item.input_audio_transcription.completed
response.output_audio_transcript.delta response.output_audio_transcript.done
```

## Decision: NO-GO on enabling the filter by itself

Four events our shipped, gated features depend on are **absent** from that list:

| Missing event | Feature it breaks | Gate that would fail |
|---|---|---|
| `session.created` | Rotation reads `expires_at` from it [MS17] — with no event, no rotation is ever scheduled and a call dies at the 60-minute ceiling [MS14] | m3.t3.1, m3.t3.2 |
| `output_audio_buffer.cleared` | The ⏹ interruption marker keys on it [MS8] | m3.t2.1, m3.t2.4 |
| `response.created` | The `speaking` flag that defers rotation mid-sentence; also the self-response safety count | m3.t3.3, m1.t1.2 |
| `response.done` | Rotation's "wait for the sentence to finish"; the rig's injection sequencing | m3.t3.3, m1.t2.1 |

So the filter is not a drop-in hardening step for this architecture. It is designed
for pages that only render transcripts; ours also owns session lifecycle and
interruption UI. Enabling it would trade a modest confidentiality gain for the loss of
hour-long calls and interruption feedback — both of which are gated behaviour.

*(What the filter would NOT break, for the record: transcription capture and
say-exactly playback both ride on allowed events, so M5.T2#2 and #3 would likely have
passed — which is exactly how a partial test suite can bless a breaking change.)*

## The proper path: observer first, filter second

[MS9] describes the architecture that resolves the conflict: proxy the SDP negotiation
server-side, keep a `wss` observer on the call, and move **all** injection and
lifecycle handling to the server. The browser then needs nothing but audio and
transcripts — precisely the filtered set — and the instructions never reach it at all.

That is a real refactor, not a flag:

- `/token` must stop returning the ephemeral key to the browser; the server negotiates
  the SDP on the page's behalf and returns only the answer.
- Rotation, `speaking` state, interruption marking and injection move server-side.
- The synthetic voice rig's readiness/sequencing signals move to the observer stream.

Estimated blast radius: `talk-server.js`, `talk.html`, `tests/rig/driver.mjs`, and the
m1/m3 gates that observe browser-side events. Roughly a milestone's worth of work.

## Consequences

- **Now:** the filter stays off. Documented rather than silently skipped.
- **Residual risk accepted:** the page holds the say-exactly instructions. Mitigated by
  loopback-only binding, the per-process auth token, and the Origin allowlist added
  after the 2026-07-26 security review. This is a single-user local tool, not a hosted
  service.
- **Next:** if the owner wants the browser to be zero-trust, schedule the observer
  refactor as its own milestone with its own gates. It is the only path that gets both
  privacy and the lifecycle events this product needs.

## Citations

- [MS9] [Realtime API via WebRTC](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-webrtc) → *Step 3 (optional): Create a websocket observer/controller* — "parse the Location header… create a websocket connection to the WebRTC call. This connection can record the WebRTC call and even control it"
- [MS10] same page → *Step 2* — "This query parameter limits the data channel messages sent to the browser to keep your prompt instructions private." (allowed list reproduced above, fetched 2026-07-26)
- [MS14] 60-minute session ceiling · [MS17] rotation driven by `session.created`'s `expires_at` · [MS8] `output_audio_buffer.cleared` on interrupt
