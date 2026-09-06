# Voice-Conversation Design Patterns for a Puppet-Mode Realtime Agent
Research report — prioritized, cited recommendations. Scope: improvements *within* an architecture where a separate reasoning agent authors words and gpt-realtime is ears+mouth only.

Source tiers used: **[V] vendor doc** (OpenAI/Microsoft/Google official), **[F] framework doc** (LiveKit, Pipecat, Deepgram, Vapi product docs), **[C] community/vendor-blog writeup or one team's opinion**.

---

## Tier 1 — highest quality-per-effort

### 1. Split "spoken answer" from "full answer": summarize-then-offer-detail, capped at ~3 items
**Change:** Have the reasoning agent emit a structured turn envelope, e.g. `{spoken_text, full_detail, has_more:true, remaining_count:7}`. Speak the gist + at most 3 items, then explicitly offer the rest ("that's the first three of ten — want the rest, or should I send the full list to the screen?"). Never silently truncate; always state the count so the user knows completeness exists.
**Why:** This is the single documented fix for your problem #1/#2 — brevity currently *destroys* completeness because the model has no channel for the remainder. Vapi's response-guideline template literally prescribes "Never list more than three options at a time" and "after providing an answer, end with a clarifying question"; Deepgram prescribes 1–2 sentences per turn; Google's Dialogflow design guide prescribes modeling turn length and keeping the conversation balanced. Google conversation designers separately argue the "rule of three" for spoken option sets.
- [F] https://docs.vapi.ai/prompting-guide (Response Guidelines: "Keep responses to one or two sentences maximum", "Never list more than three options at a time", "After providing an answer, end with a clarifying question")
- [F] https://developers.deepgram.com/docs/prompting-voice-agents (§7 Speaking style rules: "Keep responses to one or two short sentences")
- [V] https://docs.cloud.google.com/dialogflow/cx/docs/concept/voice-agent-design (conversation turn pairs, balance, model the language you want)
- [C] https://medium.com/google-design/for-conversation-design-three-is-greater-than-seven-54b03d25b101
**Honest caveat:** there is *no* vendor-documented "progressive disclosure for voice" pattern by that name. The "≤3 then offer more" convention is well attested across framework docs and conversation-design writing, but the exact envelope shape is your design decision, not a standard.

### 2. Make "look it up, don't recall" a tool-invocation rule with explicit triggers, not a style instruction
**Change:** In the reasoning agent's prompt, list the concrete triggers that force a retrieval/tool call ("when the user asks for all/every/list/how many X, call `lookup_X` and answer only from its result — never from memory"), and make the tool description action-oriented ("call this to retrieve **all** relevant records for the query, then respond with the combined results").
**Why:** Deepgram documents this exact failure and fix: a description like "respond naturally to the query field" causes the model to skip the function and answer from its own head; changing it to "call this to retrieve all relevant records… then respond with the combined results" "changes the behavior immediately." They also say to write explicit triggers in the prompt rather than relying on the schema alone. OpenAI's realtime guide similarly says to spell out per-tool "Use when / Do NOT use when."
- [F] https://developers.deepgram.com/docs/prompting-voice-agents (§8 Function calling)
- [V] https://developers.openai.com/cookbook/examples/realtime_prompting_guide (Tool Call Performance; Tool Level Behavior)
**Also documented:** multi-tool chaining is unreliable on small models — "call ALL FOUR functions" often yields one call. Test with your actual model rather than assuming. [F, Deepgram, same page]

### 3. Rewrite the brevity instruction as a *shape* constraint, not a length constraint
**Change:** Replace "be brief" with an explicit template. OpenAI's canonical responder-thinker template: **opener + one-sentence gist + up to 3 key details + a quick confirmation/choice**, ≤2 sentences. Add a Completeness rule that outranks brevity: "If the true answer has more items than you can say, say the count and offer the rest. Never present a partial list as complete."
**Why:** OpenAI's Realtime Prompting Guide has a section named exactly for your architecture — **"Rephrase Supervisor Tool (Responder-Thinker Architecture)"** — and gives this template verbatim. Also: prefer bullets over paragraphs, be precise, ambiguity/conflict degrades performance.
- [V] https://developers.openai.com/cookbook/examples/realtime_prompting_guide (Rephrase Supervisor; General Tips)

### 4. Fix the verbatim-reading contract by wrapping the text in a JSON envelope
**Change:** Instead of `response.create` with prose instructions "read this verbatim," pass the text as a structured payload — `{"response_text": "...", "require_repeat_verbatim": true}` — and instruct: "If `require_repeat_verbatim` is true, output exactly `response_text` and nothing else."
**Why:** OpenAI documents that raw strings plus a "repeat exactly" instruction are out-of-distribution and cause paraphrase, truncation, dropped fields and injected preambles; a small explicit JSON envelope is more in-distribution and "more reliable." This is directly on-point for puppet mode.
- [V] https://developers.openai.com/cookbook/examples/realtime_prompting_guide (Tool Output Formatting)

### 5. Move enforcement out of the prompt and into your Node server
**Change:** Anything reliability-critical — suppressing speech during in-flight reasoning, gating filler, dropping stale SSE text after a barge-in, enforcing "no markdown" — should be server-side gates, not prompt rules.
**Why:** Deepgram states this as a rule of thumb: "if you're writing increasingly emphatic rules ('ABSOLUTELY NEVER') and the model still violates them, move the enforcement to server code." They specifically cite pre-function narration leaking to TTS as needing server-side suppression.
- [F] https://developers.deepgram.com/docs/prompting-voice-agents (What the prompt can and can't enforce)

---

## Tier 2 — real gains, moderate effort

### 6. Filler phrases: fire them *coupled to the lookup event*, not at a 4-second timer; and inject them server-side
**Change:** Emit the filler the moment the server dispatches to the reasoning agent (or when the agent starts a retrieval), not after a fixed 4s. Keep a rotating pool of neutral phrases. Also add a *return* opener ("Thanks for waiting—", "Just finished checking that.") rather than starting cold with the answer.
**Why & what the docs actually say — this is the most nuanced area:**
- OpenAI **recommends** a filler/preamble, but as a *tool-call preamble*: "Before any tool call, say one short line like 'I'm checking that now.' Then call the tool immediately" — explicitly "helps mask latency." Their supervisor pattern lists approved fillers ("One moment." / "Let me check." / "Just a second." / "Give me a moment." / "Let me see." / "Let me look into that.") and the rule **"Fillers must not imply success or failure."** [V] https://developers.openai.com/cookbook/examples/realtime_prompting_guide
- Deepgram **recommends against** stalling phrases for *normal* responses — "the agent should write as if the information is already in front of it — latency is the stall" — but treats function calls as the explicit exception, and says to inject filler **server-side** (`InjectAgentMessage`, `behavior: "queue"`) because "this is server-injected, not LLM-generated, so it's reliable." [F] https://developers.deepgram.com/docs/prompting-voice-agents
- Their named gotcha applies to you directly: don't let your server filler phrase also appear in a "never say this" prompt list.
**Consensus check:** vendors agree filler is for *tool/lookup latency*, not for ordinary turns, and that it should be short, neutral, non-committal, and varied. There is **no documented latency threshold** (no vendor publishes "fire at N ms"). Your 4s is arbitrary; the documented pattern is event-coupled, not timer-coupled. Note Braintrust's (community) claim that users expect responses in 1–2s, which suggests 4s is far too late.
- [C] https://www.braintrust.dev/articles/how-to-evaluate-voice-agents

### 7. Add a Variety rule, and add explicit "unclear audio" handling
**Change:** Add to the mouth-model prompt: "Do not repeat the same sentence twice; vary your responses so it doesn't sound robotic." And: "Only respond to clear audio. If the audio is ambiguous/noisy/unintelligible, ask for clarification."
**Why:** Both are named, demonstrated fixes in the OpenAI realtime guide (Reduce Repetition; No Audio or Unclear Audio). The repetition rule specifically counteracts the robotic feel caused by a small filler pool.
- [V] https://developers.openai.com/cookbook/examples/realtime_prompting_guide

### 8. Turn detection: switch to `semantic_vad`, tune `eagerness` low, and stop treating `speech_stopped` as the turn boundary
**Change:** Set `session.audio.input.turn_detection.type = "semantic_vad"` with `eagerness: "low"` (or `"auto"`). Keep barge-in interruption on VAD-like responsiveness, but end-of-turn on semantics.
**Why:** OpenAI documents semantic VAD as a semantic classifier that lengthens the timeout when the user trails off ("ummm…") and shortens it on definitive statements; "the model is less likely to interrupt the user." `eagerness: low` "will let the user take their time to speak." Your problem #4 (turn-taking depends on `speech_stopped`) is exactly the failure mode semantic VAD exists to fix.
- [V] https://developers.openai.com/api/docs/guides/realtime-vad
- Cross-framework agreement that pure-VAD endpointing is the wrong default: LiveKit makes a learned turn-detector model the *default* and calls VAD-only "for minimal latency" only; Pipecat as of v0.0.102 makes Smart Turn v3 the **default** user-turn-stop strategy. [F] https://docs.livekit.io/agents/logic/turns/ , [F] https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview
**Concrete numbers you can borrow** (framework-documented defaults, treat as starting points, not truth):
- LiveKit recommended starting config: endpointing `min_delay 0.5s`, `max_delay 3.0s`; interruption `mode "adaptive"`, `min_duration 0.5s`, `min_words 0`. [F] https://docs.livekit.io/agents/logic/turns/tuning/
- OpenAI server_vad defaults: `threshold 0.5`, `prefix_padding_ms 300`, `silence_duration_ms 500`. [V] realtime-vad
- Vapi: default wait-before-speaking 0.4s, raise past 1.0s for domains where users pause mid-thought; stop-speaking `voiceSeconds 0.2`, `backoffSeconds 1`. [F] https://docs.vapi.ai/customization/speech-configuration
- Pipecat: VAD `stop_secs` 0.2s recommended alongside Smart Turn. [F] Pipecat smart-turn overview

### 9. Backchanneling: distinguish "agent emits backchannels" from "agent tolerates the user's"
**Change:** Prioritize the second. Add a minimum interruption duration/word count so "mm-hm", "yeah", "right" while the assistant speaks do **not** cancel the turn. Only then consider agent-side backchannels.
**Why:** This is where framework consensus is strongest. LiveKit's `interruption.mode: "adaptive"` (their default and recommendation) "uses an audio model to distinguish real interruptions from backchannel acknowledgments." Vapi documents the same problem explicitly for audio-based endpointing ("distinguishing meaningful interruptions from casual acknowledgments") and exposes configurable acknowledgement words + `numWords`.
- [F] https://docs.livekit.io/agents/logic/turns/ and /tuning/
- [F] https://docs.vapi.ai/customization/speech-configuration
**Honest caveat:** there is **no vendor guidance recommending the agent emit "mm-hm" backchannels** while the *user* speaks. Nobody documents that as a best practice. The closest thing is LiveKit's blog arguing for engineered disfluencies ("um" + a 300ms break + a recovery "so"), plus emotion tags used as constraints not decorations — but that is one vendor's blog opinion, is tuned for TTS/SSML pipelines, and directly conflicts with brevity/professionalism goals. Treat as experimental. [C] https://livekit.com/blog/prompting-voice-agents-to-sound-more-realistic

### 10. Format-for-the-ear rules belong in the *reasoning agent's* prompt, not the mouth's
**Change:** Since the reasoning agent authors the verbatim words, it must own the voice-formatting contract: no markdown, no bullets, no brackets/stage directions, no URLs; spoken forms for money/dates/phones ("forty-two dollars and fifty cents", "March fourth, twenty twenty-five", digits grouped); "first… then… finally…" instead of numbered lists.
**Why:** Deepgram's headline framing — "TTS reads characters literally: `**important**` becomes 'star star important star star'"; their example prompt opens with "YOU ARE A TEXT GENERATOR FOR A VOICE SYSTEM… write as if you're writing a script for someone else to read aloud verbatim," which is precisely puppet mode. Vapi gives the written→spoken conversion table. OpenAI adds alphanumeric read-back rules (speak codes character-by-character, hyphen separated) and Reference Pronunciations.
- [F] https://developers.deepgram.com/docs/prompting-voice-agents
- [F] https://docs.vapi.ai/prompting-guide
- [V] https://developers.openai.com/cookbook/examples/realtime_prompting_guide

---

## Tier 3 — structural / longer-horizon

### 11. Structure both prompts into labeled sections
Three independent vendors converge on nearly the same skeleton, which is about as close to industry standard as this field gets:
- OpenAI: Role & Objective / Personality & Tone / Context / Reference Pronunciations / Tools / Instructions / Conversation Flow / Safety & Escalation. Plus: prefer bullets over paragraphs; guide with examples; CAPITALIZE key rules; convert non-text rules to text. [V] realtime_prompting_guide
- Vapi: Identity & Personality / Response Guidelines / Guardrails / Context / Workflow / Examples (≥3 few-shots: happy path, edge case, error recovery). [F] https://docs.vapi.ai/prompting-guide
- Deepgram: 10 sections incl. Environment & Channel, About your callers, Scope-with-fallbacks, Speaking style, Terminology/pronunciation. [F]
**Anti-pattern flagged by Vapi:** long "never say X, Y, Z" banlists — every banned phrase is an active token and can be over-sampled; prefer a short positive principle. Relevant if you're fighting verbosity with negative lists.

### 12. Memory/state: retrieve-before, write-after-async; scope what gets stored
**Change:** Keep memory writes strictly off the critical path (async, after the reply is delivered). Retrieve a small, task-scoped set before the reasoning call. Use domain-specific extraction instructions ("extract X, Y; do not extract greetings or filler") rather than generic extraction. Prefer per-round writes over per-session for crash resilience.
**Why:** [C] https://mem0.ai/blog/ai-memory-for-voice-agents — a vendor blog, not neutral, but the architectural claim (async writes off the critical path; over-capture degrades retrieval) is uncontroversial.
**Related documented pattern — swap prompts instead of growing them:** Deepgram's Update Prompt and OpenAI's per-state `session.update` both replace the instruction set per conversation phase rather than cramming all branches into one static prompt — "cheaper on latency and easier to debug."
- [F] https://developers.deepgram.com/docs/voice-agent-update-prompt (via the prompting guide)
- [V] realtime_prompting_guide (build_session_update per state)
**Honest caveat:** there is **no vendor-documented standard** for long-term cross-session memory in voice agents. This is the least settled area in the whole report.

### 13. Evaluation beyond latency
Adopt a small scored eval set. Documented metric sets:
- [V] Google/Dialogflow: **misroute, first-call resolution, average handling time, customer satisfaction, number of turns to task completion, user churn (disengagement)**. https://docs.cloud.google.com/dialogflow/cx/docs/concept/voice-agent-design
- [C] Braintrust: LLM-as-judge with an explicit rubric over naturalness, contextual appropriateness, empathy and **information completeness**; segment offline evals per code change + continuous online scoring; "test your responses by listening to them, not only reading transcripts." https://www.braintrust.dev/articles/how-to-evaluate-voice-agents
- [F] Vapi: validate prompt changes against a **representative test set, not single calls** — "probabilistic regressions don't show up in one-off testing." https://docs.vapi.ai/prompting-guide
- [F] LiveKit: use observability to confirm a tuning change actually moved the metric; notes preemptive generation "doesn't always reduce latency." https://docs.livekit.io/agents/logic/turns/tuning/
**Directly relevant to you:** an "information completeness" judge on your exhaustive-list failure would have caught problem #1 automatically.
- Community consensus exists on *what* to measure; there is **no standard benchmark** for conversation quality. LiveKit publishes eot-bench for end-of-turn only (https://github.com/livekit/eot-bench).

### 14. Speculative/optional: preemptive generation
LiveKit enables preemptive generation by default (start LLM work before end-of-turn is confirmed) but explicitly warns it "doesn't always reduce latency" and costs wasted compute on cancellations; they default preemptive *TTS* to off. Given you already handle barge-in cancellation, this is a plausible experiment for your `/turn` path — but treat it as unproven for your setup.
- [F] https://docs.livekit.io/agents/logic/turns/tuning/

---

## Where the community has NO consensus (stated plainly)
- **Agent-emitted backchannels** ("mm-hm" while the user talks): no vendor recommends it; no documented threshold; essentially unaddressed.
- **A latency threshold for firing filler**: not published by any vendor. The documented pattern is event-coupled (fire on tool/lookup dispatch), not timer-coupled.
- **Engineered disfluencies / "um" + SSML breaks**: one vendor blog (LiveKit) advocates strongly; conflicts with Deepgram's "no brackets, TTS reads them literally" and with brevity goals. Unresolved.
- **Long-term memory architecture for voice**: no vendor standard.
- **Progressive disclosure of long lists**: convergent convention (≤3 items, offer more, end with a question) but no named, documented pattern.
