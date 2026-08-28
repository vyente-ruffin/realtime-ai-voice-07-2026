# PROGRAM.md — voice latency tuning

Scope contract for the `autoresearch-loop` skill. Human edits this file; the
loop does not.

## Goal

Reduce the time between V finishing a sentence and JARVIS starting to answer,
**without losing memory access or answer quality.**

## Metric

`turn_ms` from `logs/turns-routed.log` — milliseconds from `/turn` receiving the
transcript to the spoken answer being ready. **Lower is better.** Report median
across the fixed question set, not the mean (one slow outlier should not decide
a run).

## Guard metrics — a win that breaks these is a DISCARD

| Guard | Check | Pass condition |
|---|---|---|
| Memory access | Q1 "What is my name?" | says Vyente / V |
| Memory access | Q2 "Who is my wife?" | says Teresa |
| Memory depth | Q3 "What projects am I working on right now?" | names ≥2 real projects |
| Memory depth | Q4 "What do you know about me?" | Microsoft + home lab + Teresa |
| No stalls | any question | no turn > 15000 ms (the handoff boundary) |

V's requirement, verbatim: *"I want it to have full access to my memories the
same way you do."* Any config that trades a guard for speed is a discard, no
matter how fast it is.

## Fixed benchmark

Five questions, same order, every run, via `POST /turn` with
`provenance: "synthetic test input"`. Three repeats per config; report the
median. One warm-up turn is discarded before measurement (first call after a
restart pays init cost).

Deliberately mixed: two cheap factual lookups, two that require real recall
breadth, one conversational filler turn that should ideally NOT trigger a
full memory search.

## In scope — the ONLY things the loop may change

- `~/.hermes/profiles/voice/hindsight/config.json`
  (`recall_budget`, `recall_max_tokens`, `recall_types`, `memory_mode`,
  `auto_recall`, `prefetch_method`)
- `~/.hermes/profiles/voice/config.yaml` — voice profile only
  (model selection, enabled toolsets/MCP, `environment_hint`)
- The voice session's `turn_detection` block sent to Azure
  (`type`, `eagerness`, `silence_duration_ms`, `threshold`, `prefix_padding_ms`)
- The filler timer threshold in `talk-server.js`

## Out of scope — DO NOT TOUCH (V, explicitly)

- **`talk.html` and any website UI** — no layout, styling, controls, or copy.
- **Any Azure resource** — no new deployments, no new accounts, no SKU or
  capacity changes, no region changes, no new services. `ai103-resource-ruffin`
  / `gpt-realtime-2.1` stays exactly as it is.
- **No new technologies.** Settings on the existing stack only.
- Other Hermes profiles (`default`, `coder`, `homelab-it`,
  `microsoft-engineer`) — they keep `recall_budget: high`.
- The shared memory bank contents.
- `tuning/bench.py` once the baseline is recorded.

## Idea sources — every run cites one

- Hindsight docs via **context7** (`/vectorize-io/hindsight`)
- Azure realtime docs via **microsoft-learn MCP**
- A measured observation from an earlier run in `results.tsv`

No uncited hypotheses.

## Budget

12 runs, or until three consecutive runs fail to beat the current best.

## Restart discipline

Hermes and Hindsight read config at process start. Every run must restart
`talk-server.js` and confirm the new value appears in the startup log line
(`Hindsight initialized: ... budget=<value>`) before the measured turns. A run
that skips this measures the previous config and is void.
