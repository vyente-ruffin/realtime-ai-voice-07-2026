# Voice latency — research findings (Microsoft Learn), 2026-08-28

Research only. Nothing in this document has been applied. Every claim is cited
to Microsoft Learn; the measured numbers are from this host's own logs
(`logs/turns-routed.log`, 23 turns).

## 1. Where our time actually goes

Our architecture is *puppet mode*: the Azure realtime model is the ears and
mouth, and the answer comes from a separate Hermes turn (`POST /turn` →
`hermes -p voice acp`). So our latency is not realtime-API latency — it is
**agent latency wearing a realtime front end**.

Measured: median 2.2 s, min 1.56 s, max 7.2 s. From `agent.conversation_loop`,
the Hermes model call is 1.5–3.0 s of that, at 27k–47k prompt tokens with
80–86% cache hits. The prompt grew 27k → 47k across six turns because recall
injects 57–68 memories per turn.

Conclusion: the transport is not the problem, and swapping realtime models will
not fix it. The two levers that matter are (a) what we ask the brain to read,
and (b) whether the user hears anything while it thinks.

## 2. `interim_response` — the documented fix for exactly our shape

Microsoft ships a first-class feature for "tool calling or generating agent
responses with **high latency**". Two modes:

- `llm_interim_response` — a lightweight model generates context-aware filler
  text dynamically.
- `static_interim_response` — randomly selects from a list of texts you provide.

<https://learn.microsoft.com/azure/ai-services/speech-service/how-to-voice-live-interim-response>
<https://learn.microsoft.com/azure/ai-services/speech-service/how-to-voice-agent-integration#improve-tool-calling-and-latency-wait-times>

This is the supported version of the hand-rolled 4-second filler line already in
`talk.html`. **Caveat: `interim_response` is a Voice Live API feature, not an
Azure OpenAI Realtime API feature.** We are on the latter (see §4). Adopting it
means moving to Voice Live.

## 3. Turn detection — free latency at the front of every turn

Time is also spent *before* the brain is called, waiting to decide the user
stopped talking. Documented options:

| Type | Behavior | Model support |
|---|---|---|
| `server_vad` | Volume/silence based. **Default.** | all |
| `semantic_vad` | Classifier decides if the utterance is complete; dynamically extends timeout. `eagerness` = `low`/`medium`/`high`/`auto` trades latency against interrupting the user | **supported on our deployment — verified live, see §3.1** |
| `azure_semantic_vad` / `_multilingual` | Semantic + filler-word removal to cut false barge-in | all models — **Voice Live only** |

Tunables (Voice Live reference, `2026-04-10`): `threshold` (0.5),
`prefix_padding_ms` (420), `silence_duration_ms` (500), `speech_duration_ms`
(80), `remove_filler_words` (false), `auto_truncate` (false).

`end_of_utterance_detection` (`semantic_detection_v1`, `threshold_level`,
`timeout_ms` default 1000) is documented as reducing premature end-of-turn
signals "**without adding user-perceivable latency**".

### 3.1 CORRECTION (same day) — `semantic_vad` IS available to us

An earlier revision of this document claimed semantic turn detection required
moving to Voice Live. That was wrong, and it was wrong in the direction that
costs us a real, in-stack improvement.

`semantic_vad` is an **Azure OpenAI Realtime** turn-detection type
(`OpenAI.RealtimeTurnDetectionSemanticVad`, with an `eagerness` enum of
`low`/`medium`/`high`/`auto`), and the docs scope it to `gpt-realtime` and
`gpt-realtime-mini` — our deployment is `gpt-realtime-2.1`, in that family.

Verified live against our own resource, not inferred. `POST
/openai/v1/realtime/client_secrets` on `ai103-resource-ruffin`:

```
server_vad (current)         -> 200, echoed {"type":"server_vad","threshold":0.5,
                                "prefix_padding_ms":300,"silence_duration_ms":500,
                                "idle_timeout_ms":null,"create_response":false,
                                "interrupt_response":true}
semantic_vad eagerness=high  -> 200, echoed {"type":"semantic_vad","eagerness":"high",
                                "create_response":false,"interrupt_response":true}
semantic_vad eagerness=low   -> 200, echoed {"type":"semantic_vad","eagerness":"low",
                                "create_response":false,"interrupt_response":true}
```

The server accepts and echoes the config back, so it is not silently dropped.

What still requires Voice Live: `azure_semantic_vad` / `_multilingual`,
`remove_filler_words`, `end_of_utterance_detection`, and `interim_response`.
Plain `semantic_vad` does not.

Latency note: the "may have higher latency" caveat in the docs refers to
`semantic_vad` deliberately *waiting longer* when it scores a low
probability that you have finished (audio trailing off into "uhhm").
`eagerness: "high"` biases the opposite way — commit sooner. So this is a
tunable, not a fixed tax, and `high` is the setting to evaluate for our case.

We currently run `server_vad` with `silence_duration_ms: 500` — a fixed
half-second wait on **every** turn regardless of whether the sentence sounded
finished. That fixed wait is the thing `semantic_vad` replaces.

<https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to#conversational-enhancements>
<https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-api-reference-2026-04-10#components>

## 4. Realtime model inventory (what we could deploy today)

Azure OpenAI Realtime, global deployments, East US 2 and Sweden Central:

`gpt-4o-realtime-preview` (2024-12-17), `gpt-4o-mini-realtime-preview`
(2024-12-17), `gpt-realtime` (2025-08-28, GA), `gpt-realtime-mini` (2025-10-06,
2025-12-15), `gpt-realtime-1.5` (2026-02-23), **`gpt-realtime-2` (2026-05-07)**,
`gpt-realtime-translate` (2026-05-06), `gpt-realtime-whisper` (2026-05-06),
`gpt-live-transcribe` (2026-07-29).

Realtime models cap at 32,000 input tokens. Our deployment is
`gpt-realtime-2.1` — current generation. Microsoft publishes **no comparative
latency benchmark** between these; the only relative-latency statements in the
docs are about turn detection (§3), not model choice. Anyone quoting per-model
realtime latency figures is not quoting Microsoft.

Note: `gpt-4o-*-preview` are explicitly not recommended for production.

<https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio#supported-models>
<https://learn.microsoft.com/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure#audio-models>

## 5. Voice Live — the strategic option

Voice Live is the managed voice-agent stack. Relevant properties:

- **No audio model deployment required** — fully managed, model auto-deployed.
- Brain model options in its evaluation harness: `gpt-realtime` (default),
  `gpt-5`, `gpt-4.1`, `gpt-5-mini`, `phi4-mini`.
- Ships `interim_response` (§2), `azure_semantic_vad` + EOU (§3), and
  `auto_truncate` for barge-in-accurate history.
- **Agent mode requires Microsoft Entra ID.** Key-based auth is not supported
  for agent invocation.
- Microsoft publishes an evaluation harness with recommended configs:
  <https://github.com/microsoft-foundry/voicelive-evaluation>

The catch for us: Voice Live's agent mode expects a **Foundry** agent, not a
local Hermes process. Using Voice Live while keeping JARVIS as the brain means
running it in model mode and calling Hermes ourselves — which is what we
already do, so the gain would be `interim_response` + `azure_semantic_vad`, not
a shortcut around the agent turn.

<https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-agents-quickstart>
<https://learn.microsoft.com/azure/ai-services/speech-service/how-to-voice-agent-integration>
<https://learn.microsoft.com/azure/ai-services/speech-service/how-to-voice-live-evaluate#configure-the-evaluation>

## 6. What the research says to do, in order

1. **Cap recall.** Prompt growth 27k → 47k is ours, not Azure's, and it is the
   only mechanism observed making later turns slower. No doc needed; it is a
   Hermes setting.
2. **Switch turn detection to `semantic_vad`, `eagerness: "high"`.** In-stack,
   no migration, verified accepted by our own deployment (§3.1). Replaces a
   fixed 500 ms wait on every turn with a "did that sound finished?" decision.
3. **Adopt a documented interim response** rather than the hand-rolled 4 s
   filler. Requires Voice Live (§2).
4. **`azure_semantic_vad` + EOU + filler-word removal** for further front-of-turn
   gains. Requires Voice Live (§3).
5. **Do not chase realtime model versions for latency.** Microsoft publishes no
   benchmark supporting that, and in puppet mode the realtime model is not on
   the critical path for answer generation.

Items 1 and 2 need nothing from Microsoft and no migration. Items 3 and 4 are
gated on a decision to move the front end from Azure OpenAI Realtime to Voice
Live — that decision is the only open question, and it is a decision, not more
research.
