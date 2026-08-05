---
name: voice-transcript
description: Read what was actually said in the EON/hermes voice app — full two-sided conversation transcripts, latency, barge-ins, and whether the voice stayed faithful to the brain. Use whenever asked what was said, what it replied, "show the conversation", "did it answer X", "why did it say that", "read the transcript", or any question about past voice sessions. ALSO use before ever claiming a voice conversation is not recorded — it is.
---

# Reading voice conversation transcripts

The full two-sided conversation **is on disk**. Never say it isn't.

**Logs live in:** `/Users/sudo/GIT/405network/foundry/realtime-audio-quickstart-js/logs/`

If the host is remote, prefix any command with `ssh <user>@<host> '<command>'`.
Over Tailscale, get the address with `tailscale status | grep <machine>` — use
the IP rather than the `.ts.net` name, which fails when the client's DNS is not
Tailscale's.

## Which file to open

Pick by what's being asked. Opening the wrong one is how you conclude, incorrectly, that replies aren't stored.

| Question | File |
|---|---|
| **"What was said?"** — full conversation, both halves | `voice-audit.log` |
| How long did turns take, how did they end | `turns-routed.log` |
| Raw user speech as it arrived | `turns.log` |
| Did it stall / play a filler | `fillers.log` |
| Did it interrupt or drop a reply | `cancel.log` |
| Async task completions pushed out-of-turn | `announcements.log` |
| Hand-offs between voice and brain | `handoff.log` |
| Session settings (puppet mode, VAD, model) | `session-config.log` |

## ⚠️ Printing: Bash output does NOT reach the user

**Bash results are shown to you, not reliably to the user's screen.** Running a
script that prints a transcript and then saying "printed above" is a lie from
the user's side — they see nothing. This wasted an entire session once, with the
user repeatedly asking for the transcript and being told it had already been
printed.

So when asked to *show / print / read out* a conversation:

1. Run the extractor with Bash to **get** the data.
2. **Re-type the transcript into your own response text**, inside a code block.
   That is the only thing the user actually sees.

Do not substitute a file via SendUserFile unless the user asked for a file —
being handed a download when they asked to see something reads as evasion.

## voice-audit.log — the real transcript

One JSON object per line. Three kinds:

- `kind: "reply"` — a spoken turn. Fields:
  - `question` — what the user said
  - `hermesSaid` — what the brain wrote
  - `mouthSpoke` — what the voice actually spoke
  - `jaccard` — word-overlap between the two; **low means the voice improvised instead of reading the brain's words**
  - `verdict` — pass/fail on that fidelity check
- `kind: "dropped"` — reply generated but never spoken (user barged in). `mouthSpoke` is empty; `hermesSaid` holds the words.
- `kind: "filler"` — stall phrases ("One sec", "Hang on"). Skip when showing a conversation.

All text fields are stored **in full** (caps removed 2026-08-05). Entries written
before that date are still clipped at 200/600 chars — that is historical damage,
not a live bug.

Entries are only written when a **browser** posts `/spoken`. Scripted/curl turns
route through hermes correctly but leave no transcript, so the log reflects real
sessions only.

## Extract a conversation

Sessions are split on gaps > 20 min — there is no session id in the log.

```bash
cd /Users/sudo/GIT/405network/foundry/realtime-audio-quickstart-js
python3 - <<'EOF'
import json
from datetime import datetime
rows=[]
for line in open("logs/voice-audit.log"):
    try: d=json.loads(line)          # skip malformed lines: concurrent appends
    except: continue                 # can interleave (see Node fs docs)
    if d.get("kind") not in ("reply","dropped"): continue
    q=(d.get("question") or "").strip()
    a=(d.get("mouthSpoke") or "").strip() or (d.get("hermesSaid") or "").strip()
    if not q: continue
    rows.append((datetime.fromisoformat(d["at"].replace("Z","+00:00")), q, a))
sessions=[]; cur=[]
for r in rows:
    if cur and (r[0]-cur[-1][0]).total_seconds() > 1200:
        sessions.append(cur); cur=[]
    cur.append(r)
if cur: sessions.append(cur)
for s in sessions[-2:]:              # last 2 conversations
    print(f"\n===== SESSION {s[0][0].strftime('%b %d %Y %H:%M')} UTC — {len(s)} turns =====\n")
    for at,q,a in s:
        print(f"[{at.strftime('%H:%M:%S')}] YOU:    {q}")
        print(f"[{at.strftime('%H:%M:%S')}] HERMES: {a}\n")
EOF
```

Then **paste that output into your reply**. See the printing warning above.

## The trap that caused a wrong answer

`turns-routed.log` looks like the transcript but stores the reply as **`chars: 187`** — a length, not text. Concluding from that file alone that "replies aren't recorded" is wrong; `voice-audit.log` in the same directory has the words. Check `voice-audit.log` before making any claim about what is or isn't stored.

Hermes' own conversation store (`mcp__hermes__conversations_list`) holds Slack and webhook chats but **not** voice — the voice app talks to hermes over a direct ACP subprocess that never registers there. Its absence there is not evidence the transcript is missing.

## Related

The voice stack is kept online by a watchdog (`watchdog.sh` + `~/Library/LaunchAgents/com.405network.talkserver.plist`); its own log is `~/.405network/logs/talkserver-watchdog.log`, and server stdout is `~/.405network/logs/talkserver.log`.
