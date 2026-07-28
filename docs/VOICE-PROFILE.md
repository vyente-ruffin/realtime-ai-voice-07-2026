# The `voice` hermes profile

The voice path runs `hermes -p voice acp`. This profile lives at
`~/.hermes/profiles/voice/` — **outside this repo** — so its settings are
recorded here. The default profile (terminal, Telegram, Discord) is untouched.

## Why a separate profile

The default profile loads 9 MCP servers / 175 tools, costing 135–165k tokens per
turn and 5–61s replies. Voice needs conversation speed, not a full toolbelt.

## Settings that matter, and why

| Setting | Value | Reason |
|---|---|---|
| `mcp_servers.*.enabled` | `false` (all) | The tool schemas were the bulk of the context |
| `agent.disabled_toolsets` | browser, file, terminal, code_execution, vision, image_gen, video, tts, todo, session_search, cronjob, computer_use, skills, web | Voice keeps **memory**, **delegation**, **clarify** only |
| `agent.environment_hint` | "answer from memory; delegate ONLY when a tool is needed" | Without this it delegated *"what do you know about me?"* and answered `TASK-ACCEPTED` |
| `compression.threshold` | `0.15` | Computed from the documented budget formula (`threshold_tokens = context_length × threshold`). Default `0.50` let context reach ~289k → 12s+ turns. `0.06` compacted every ~5 turns → 13–43s stalls |
| `auxiliary.compression.reasoning_effort` | `low` | Docs: *"summaries don't need deep thinking."* The global effort is `high`, which made each compaction cost 13–43s |
| `compression.hygiene_hard_message_limit` | `5000` (default) | Docs: this is a **disconnect-loop safety valve**, not a latency knob. Do not repurpose it |

Sources: `website/docs/user-guide/configuration.md`,
`website/docs/developer-guide/context-compression-and-caching.md`.

## Memory

- **Honcho** (the rich user model) is shared — `honcho.json` copied from the
  default profile, same workspace `hermes`. This is what answers "what do you
  know about me".
- **File memory** (`memories/MEMORY.md`, `USER.md`) is **per-profile** — hermes'
  FAQ confirms profiles do not share it. Seeded from the default profile at
  creation. It will drift over time; re-seed if that matters. The abandoned
  pre-existing `voice` profile had drifted 11 days and was reciting stale facts.

## Measured

| | Before | After |
|---|---|---|
| Context per turn | 135–165k (fresh) → 289k (long session) | ~32k, flat |
| Turn latency | 5–61s | **3.8s average, 0 stalls over 20 turns** |
| Knows the user | yes | yes |
| Can run tools | directly | via `delegate_task` to a tool-equipped subagent |

## Recreating it

```bash
hermes profile create voice --clone       # config only, not memories
cp ~/.hermes/honcho.json          ~/.hermes/profiles/voice/honcho.json
cp ~/.hermes/memories/{USER,MEMORY}.md ~/.hermes/profiles/voice/memories/
# then apply the settings table above to ~/.hermes/profiles/voice/config.yaml
```
