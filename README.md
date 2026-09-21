# 🎙️ Realtime AI Voice — Talk to GPT Realtime on Azure AI Foundry

The September 2026 Jarvis candidate keeps this web app and adds direct GPT-Live conversation, prepared Hindsight memories, and separately tracked Hermes work. It is under qualification; production remains on the original entry point. See [the candidate and its validation limits](docs/JARVIS-LIVE.md) and [current progress](docs/JARVIS-LIVE-PROGRESS.md). The tutorial and earlier gate history below describe the original Realtime implementation.

Build a browser page where you **talk to an AI with your voice and it talks back** — with real interruption ("barge-in"), selectable voices, and no API keys ever touching the browser. Built July 2026 against `gpt-realtime-2.1` (model version `2026-07-07`, `GlobalStandard`, East US 2), tested end-to-end, including every mistake we hit along the way (documented in [Appendix A](#appendix-a--the-mistakes-we-actually-hit)).

> ### 🧠 This repo grew a brain
>
> The tutorial below builds the **voice harness** — the mouth and ears. On top of it,
> this repo now also contains the **Hermes Voice Platform**: the same realtime model
> demoted to *pure speech I/O*, with every spoken word originating from a local
> [Hermes agent](https://github.com/NousResearch/hermes-agent) — its memory, its
> Honcho user model, its skills and tools. Voice becomes another front-end alongside
> Telegram and the CLI, and the existing hermes install is provably untouched
> (checksum-gated on every test run).
>
> **What it does:** you talk, hermes answers in its own voice; ask it to start a long
> job and it acknowledges immediately, keeps chatting, then announces completion
> without ever talking over you; interrupt it and it cancels the work in flight;
> hang up and pending results arrive on Telegram.
>
> - 📋 **[The build plan](docs/VOICE-PLATFORM-PLAN.md)** — north star, 6 milestones,
>   63 binary gates, and a citation index where every API claim is traceable to
>   Microsoft Learn or the OpenAI/ACP/hermes docs.
> - 🏗 **Status:** M0–M4 built and gated (63/63, tags `v0.0.1`–`v0.4.0`). M5 (making
>   voice a first-class `hermes gateway` platform) awaits the owner's approval.
> - 🧾 **[ADR-001](docs/ADR-001-observer.md)** — why `webrtcfilter=on` was rejected
>   despite two of its own tests passing.
> - 🤖 **[CLAUDE.md](CLAUDE.md)** — machine handoff: state, gotchas, how to re-certify.
>
> **Run it:** `node talk-server.js` with the env below, wait for `"Brain warm"` in the
> log (~30s — hermes loads 175 MCP tools), then open http://localhost:8787.

---

## Change log

Append-only, newest at the bottom. Format: date — what changed — why.
Every behaviour-changing commit adds an entry here (CODER SOUL.md, RULE ZERO-D).

- 2026-09-04 — Change log started. Why: V's standing rule that every artifact
  carries a What/Why/How/When README whose changes are appended, so the history
  of a decision is readable without digging through git.
- 2026-09-04 — `talk-server.js`: an ACP reply beginning `Error: ` is now treated
  as a transport failure instead of speech — the turn fails with RFC 9457, the
  ACP child is destroyed, and a second consecutive failure exits the process for
  systemd to rebuild. Why: the ACP adapter returns an unhandled agent exception
  as a NORMAL turn whose text is `Error: <python message>`
  (`acp_adapter/server.py`), which is indistinguishable from a real answer at the
  JSON-RPC layer. A crashed brain therefore read
  `'TurnLivenessWatchdog' object has no attribute 'make_thread'` aloud to V on
  every turn from 2026-09-01 to 2026-09-04 while every process-level check said
  the service was healthy. Commit 3609f0b.
- 2026-09-04 — Added unauthenticated `GET /healthz` plus the systemd units
  `voice-frontend-health.service` / `.timer` (probe every 2 min, restart
  `voice-frontend.service` on failure). Why: the in-process detector above only
  fires when a turn COMPLETES; a wedged process completes nothing, so an external
  prober is the necessary second half of the liveness contract. The endpoint is
  deliberately unauthenticated because the auth token is minted per-process and a
  supervisor cannot hold it. Verified by SIGSTOPing the server: the probe failed
  and the service was restarted automatically.

- 2026-09-21 — Added an isolated GPT-Live entry point in the existing web app, prepared memories, persistent jobs and results, asynchronous memory saving, permissions, reconnect handling, and real received-audio qualification. Why: conversation must stay fast while Hermes works. Source/version integrity, phone acceptance, and the full scorecard remain deployment gates. See `docs/JARVIS-LIVE.md`.

---

## WHAT you're building

Two test paths, smallest first:

| # | Path | What it proves | Files |
|---|------|----------------|-------|
| 1 | **Smoke test** — send text, get spoken audio back as a `.wav` file | Your deployment works at all | `voice-test.js` |
| 2 | **Live conversation** — talk into your mic, AI answers out loud, interrupt it mid-sentence | The real voice experience | `talk-server.js` + `talk.html` |

```mermaid
flowchart LR
    subgraph You["🧑 Your machine"]
        MIC["🎤 Microphone"] --> BROWSER["Browser page<br/>talk.html"]
        BROWSER --> SPK["🔊 Speakers"]
        SERVER["Local token server<br/>talk-server.js<br/>(holds your real Azure credential)"]
    end
    subgraph Azure["☁️ Azure AI Foundry"]
        SECRETS["/realtime/client_secrets<br/>(mints 1-minute guest passes)"]
        CALLS["/realtime/calls<br/>(the actual voice call)"]
        MODEL["gpt-realtime-2.1"]
        SECRETS --- MODEL
        CALLS --- MODEL
    end
    BROWSER -- "1. give me a pass" --> SERVER
    SERVER -- "2. real token" --> SECRETS
    SECRETS -- "3. guest pass (ek_...)" --> SERVER
    SERVER -- "4. guest pass" --> BROWSER
    BROWSER == "5. live audio call (WebRTC)" ==> CALLS
```

## WHY it's built this way — first principles

**Why a "realtime" model at all?** The classic way to voice-enable an AI is a relay race: record your voice → transcribe to text (STT) → LLM thinks in text → convert reply to speech (TTS). Every baton pass adds delay and loses information (tone, hesitation, emotion). A realtime model is **one model that hears audio and speaks audio directly** — like a phone call instead of mailing letters back and forth. That's what makes sub-second, interruptible conversation possible.

**Why WebRTC for the browser (and not WebSocket)?** ELI5: a WebSocket is a walkie-talkie — you push chunks of data and hope the timing works out; *you* are responsible for capturing mic audio, encoding it, buffering playback. WebRTC is a phone line — the browser natively handles the microphone, echo cancellation, network jitter, and speaker playback. Microsoft's guidance: WebRTC for anything client-side (~50–100ms latency), WebSocket for server-to-server (~100–300ms). We use both: WebSocket for the scripted smoke test, WebRTC for the live page.

**Why a local token server?** Your Azure credential can do *anything* your account can do. You must never ship it to a browser. So a tiny local server trades your real credential for an **ephemeral key** — ELI5: a *1-minute guest pass*. The browser gets only the guest pass; even the session rules (which model, which voice, the system prompt) are baked in server-side when the pass is minted, so the browser can't tamper with them. This is the pattern Microsoft documents for production.

**Why keyless (Entra ID) instead of API keys?** No key to leak, rotate, or commit by accident. Your `az login` identity + an RBAC role is the whole story. (Standard: OAuth 2.0 / OIDC everywhere.)

## HOW — step by step from zero

### Step 0 — Prerequisites

- An Azure subscription
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed and `az login` done
- [Node.js](https://nodejs.org) 22+ (`node -v`)
- A machine with a **microphone** for Part 2 (sounds obvious — cost us an hour; a Mac mini has none)

### Step 1 — Create the Foundry resource and deploy the model

Follow: [Create a Microsoft Foundry resource](https://learn.microsoft.com/azure/ai-services/multi-service-resource?pivots=azportal) → then [deploy the realtime model](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-websockets#deploy-a-model-for-real-time-audio):

1. Go to the [Foundry portal](https://ai.azure.com), create/select a project
2. **Models + endpoints** → **+ Deploy model** → **Deploy base model**
3. Search `gpt-realtime` (or `gpt-realtime-mini` for cheaper testing) → **Deploy**
4. ⚠️ Region matters for WebRTC: use **East US 2** or **Sweden Central**

Verify from the CLI:

```bash
az cognitiveservices account deployment list \
  -g <your-resource-group> -n <your-resource-name> \
  --query "[].{deployment:name, model:properties.model.name, state:properties.provisioningState}" -o table
```

### Step 2 — Give yourself data-plane access (RBAC)

Portal → your resource → **Access control (IAM)** → **Add role assignment** → **Cognitive Services OpenAI User** → your account. ([Troubleshooting reference](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-webrtc#troubleshooting) — a 401 here usually means this role is missing.)

### Step 3 — Get the code

```bash
git clone https://github.com/<you>/realtime-ai-voice-07-2026.git
cd realtime-ai-voice-07-2026
npm install        # installs: openai, ws, @azure/identity
```

What each file is and why it exists:

| File | What | Why |
|---|---|---|
| `voice-test.js` | Text in → spoken `.wav` out over WebSocket | Prove the deployment works before adding browser complexity |
| `talk-server.js` | Serves the page + mints ephemeral keys | Keeps your real credential out of the browser (see WHY above) |
| `talk.html` | The voice UI: mic capture, WebRTC call, live transcript, voice picker | The actual "talk to it" experience |
| `index.js` | Microsoft's original [WebSocket quickstart](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-websockets#voice-agent-quickstart) sample | Untouched reference |
| `src/core/logger.js` | One structured logger every script imports | Standard: console locally, flips to Azure Monitor via one env var |

### Step 4 — Smoke test (hear it speak)

```bash
AZURE_TOKEN=$(az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv) \
AZURE_OPENAI_ENDPOINT=https://<your-resource-name>.services.ai.azure.com \
AZURE_OPENAI_DEPLOYMENT_NAME=<your-deployment-name> \
node voice-test.js
```

> 💡 If your resource is in a **different subscription/tenant** than your az default, add `--subscription <sub-id>` to the token command. This exact issue cost us the most debugging time — see [Appendix A](#appendix-a--the-mistakes-we-actually-hit).

Success looks like: a JSON log line with the transcript, and `output.wav` you can play (`afplay output.wav` on macOS). Under the hood this connects to `wss://<resource>/openai/v1/realtime?model=<deployment>` — the **GA** endpoint style: everything lives under `/openai/v1/`, **no `api-version` parameter** ([migration guide](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-preview-api-migration-guide)).

### Step 5 — Live conversation

```bash
AZURE_TOKEN=$(az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv) \
AZURE_OPENAI_ENDPOINT=https://<your-resource-name>.openai.azure.com \
AZURE_OPENAI_DEPLOYMENT_NAME=<your-deployment-name> \
node talk-server.js
```

Open **http://localhost:8787** → pick a voice → **Start** → allow the mic → talk.

What happens when you click Start (from the [WebRTC how-to](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-webrtc)):

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as talk-server.js
    participant A as Azure /client_secrets
    participant C as Azure /realtime/calls
    B->>S: POST /token {voice: "cedar"}
    S->>A: POST session config + real Entra token
    A-->>S: ephemeral key (ek_..., valid ~1 min)
    S-->>B: ephemeral key only
    B->>B: getUserMedia (mic permission)
    B->>C: SDP offer + ephemeral key
    C-->>B: SDP answer → direct audio line opens ☎️
    Note over B,C: You speak ⇄ it speaks (media track)<br/>events stream on "oai-events" data channel
```

And during conversation, each turn works like this:

```mermaid
flowchart LR
    A["You talk"] --> B["Server VAD detects<br/>you stopped<br/>(the 'polite pause' detector)"]
    B --> C["Model thinks & speaks"]
    C --> D["Transcript streams<br/>(faster than the audio!)"]
    C --> E["You interrupt?"]
    E -- "yes" --> F["Audio cut instantly +<br/>model's memory truncated<br/>to what you actually heard"]
    F --> A
    D --> A
```

### Step 6 — Tune it

The page has a **Session settings** panel — persona presets (assistant, interviewer, Spanish tutor, storyteller) with an editable system prompt, voice, speed, patience, and noise reduction — plus a mute button and a live **orb visualization**: a green core that swells when the model speaks, a blue ring that expands when it hears you, breathing when idle, gray when muted. The browser only *requests* these settings; `talk-server.js` validates and clamps every value before baking them into the ephemeral session ([events reference](https://learn.microsoft.com/azure/foundry/openai/realtime-audio-reference)):

| Knob | Values | What it does |
|---|---|---|
| `voice` | `marin`, `cedar` (newest/most natural), `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse` | The voice. **Locks after the first spoken word** of a session — that's why the page's dropdown disables while live |
| `interrupt_response` | `true` / `false` | `true` = your speech cuts it off (ChatGPT-style). `false` = it always finishes its sentence |
| `turn_detection.type` | `server_vad` (**what this repo sends**) / `semantic_vad` | `server_vad` ends your turn after a fixed silence. `semantic_vad` uses a classifier to decide whether the sentence actually sounded finished, and sets the timeout dynamically — so "and, uhh..." doesn't cut you off. Supported on `gpt-realtime` / `gpt-realtime-mini` family, which includes `gpt-realtime-2.1`; verified accepted by this deployment |
| `eagerness` | `low` / `medium` / `high` / `auto` (default `auto`) | `semantic_vad` only. `high` commits to your turn sooner (lower latency, more risk of cutting you off); `low` waits longer |
| `silence_duration_ms` | e.g. `500` | `server_vad` only. How long a pause means "your turn is over". This repo sends `500`, so every turn pays a fixed half-second before the brain is even called |
| `speed` | `0.25`–`1.5` | Talking speed |
| `instructions` | text | The system prompt |
| `noise_reduction` | `near_field` / `far_field` | Match your mic: headset vs room/laptop mic |
| `transcription` | `{ model: "whisper-1" }` | Enables "You:" lines — without it, your side of the conversation is never transcribed |

### Step 7 — Reach it from your phone (or any other machine)

`getUserMedia` refuses to hand over a microphone unless the page is a **secure context** — `https://` or `localhost`. That single rule is why the app works on the host machine and appears "broken" everywhere else. Two ways around it:

**A. Another computer — SSH tunnel.** The page arrives as `localhost`, which counts as secure:

```bash
ssh -L 8787:localhost:8787 <user>@<host>     # leave running
# then open http://localhost:8787 on your laptop
```

**B. A phone — [Tailscale](https://tailscale.com) with real HTTPS.** A tunnel isn't an option on iOS, and a self-signed cert still blocks the mic. Tailscale issues a genuine Let's Encrypt certificate for your machine's private `.ts.net` name, so the browser grants mic access:

```bash
tailscale serve --bg 8787       # proxies https://<machine>.<tailnet>.ts.net -> localhost:8787
tailscale serve status          # confirm
```

Install Tailscale on the phone, sign in with the same account, then open `https://<machine>.<tailnet>.ts.net`. Nothing is exposed to the public internet — only your own devices can reach it.

Two things that will bite you:

- **The server's CORS allowlist must include the tailnet origin.** A phone's `Origin` is the `.ts.net` hostname, not `localhost`; without it every `/token` call returns `403` while the page itself loads fine. `talk-server.js` accepts `https://*.ts.net` for this reason.
- **On wifi the hostname may not resolve.** `.ts.net` names are answered only by Tailscale's resolver (`100.100.100.100`). If a phone prefers the local router's DNS it will fail on wifi and work on cellular — a confusing split. Fix: enable **"Use Tailscale DNS"** in the phone's Tailscale app, or **"Override local DNS"** in the [tailnet DNS admin page](https://login.tailscale.com/admin/dns).

### Step 8 — Keep it running

Started by hand, the server dies with its terminal and nothing survives a reboot. `watchdog.sh` plus a launchd agent fixes that. Every 30 seconds it verifies the listener, the real local application page, the exact Tailscale Serve proxy, the certificate-backed remote page, and the `hermes -p voice acp` child. Every five minutes it also mints (but never prints) a real Azure Realtime ephemeral key. A failed check converges Tailscale/Serve and restarts the voice stack, then verifies recovery.

```bash
cp watchdog.sh <somewhere-stable>            # it references absolute paths; edit REPO/PORT at the top
launchctl load ~/Library/LaunchAgents/com.405network.talkserver.plist
bash tests/watchdog-healthcheck.sh            # healthy + three fail-closed scenarios
tail -f ~/.405network/logs/talkserver-watchdog.log
```

The launchd agent must set `PATH` explicitly — launchd does **not** inherit your shell's, so `~/.local/bin` is missing and the server dies at startup with `spawn hermes ENOENT`.

Chosen over installing `tailscaled` as a root system daemon: identical recovery from reboots and crashes, one moving part instead of two, no `sudo`. The tradeoff is that it runs in the login session, so a full logout stops it — irrelevant on an always-logged-in machine, wrong for a headless server.

### Where the conversation is recorded

`logs/` holds several files that look interchangeable but are not:

| File | Contents |
|---|---|
| **`voice-audit.log`** | **The real transcript** — `question`, `hermesSaid` (what the brain wrote), `mouthSpoke` (what was actually said), plus a `jaccard` score flagging when the voice improvised instead of reading the brain's words |
| `turns-routed.log` | Latency only — your words in full, but the reply as `chars: 187`. **Not** a transcript |
| `turns.log` | Raw user speech as it arrived |
| `fillers.log` / `cancel.log` / `announcements.log` | Stalls, barge-ins, out-of-turn task completions |

Read the conversation:

```bash
grep '"kind":"reply"' logs/voice-audit.log | tail -5 | \
  python3 -c 'import sys,json
for l in sys.stdin:
    d=json.loads(l); print("YOU:",d["question"][:120]); print("AI :",d["mouthSpoke"][:200],"\n")'
```

---

## Troubleshooting (every one of these actually happened)

| Symptom | Real cause | Fix |
|---|---|---|
| WebSocket fails with opaque `400` | Token minted for the **wrong tenant** (multi-tenant account) | `az account get-access-token --subscription <sub-that-owns-the-resource> ...` |
| `AADSTS700016` when setting `AZURE_TENant_ID` | Your default az login doesn't exist in that tenant | Same fix — select by `--subscription`, not `--tenant` |
| curl test of the WS endpoint returns `404` | curl used HTTP/2, which silently drops the `Upgrade` | Add `--http1.1` |
| `NotFoundError: The object can not be found here` | **The machine has no microphone** | Plug in AirPods/headset; it's hardware, not code |
| Page works locally, mic dead from another computer | `getUserMedia` needs a secure context (`https://` or `localhost`) | SSH tunnel: `ssh -L 8787:localhost:8787 user@host`, then open `localhost:8787` there |
| It stops talking but text keeps printing | By design — text streams faster than speech; on interrupt the *audio* is cut and the model's memory truncated to what you heard | Cosmetic: freeze the transcript on `output_audio_buffer.cleared` (this repo does) |
| Your "You:" line appears *after* the model's reply to it | Input transcription (whisper) is a slower parallel job — the model answers your raw audio before your words are transcribed | Reserve the line on `input_audio_buffer.committed`, fill it by `item_id` when transcription completes (this repo does) |
| `/token` starts failing after ~1 hour | Entra token expired | No longer applies — `talk-server.js` re-mints via `az` before expiry. If it still fails, your `az` session itself has lapsed: `az login` |
| `401` on `/client_secrets` | Missing RBAC role | Step 2 |
| `403` on WebRTC | Resource not in East US 2 / Sweden Central | Redeploy in a supported region |
| Page loads on the phone, but `/token` returns `403` | The CORS allowlist has only `localhost`; the phone's `Origin` is the `.ts.net` hostname | Allow `https://*.ts.net` (Step 7) |
| Works on cellular, fails on wifi | Phone is asking the local router's DNS, which knows nothing of `.ts.net` | "Use Tailscale DNS" on the phone, or "Override local DNS" tailnet-wide (Step 7) |
| Server dies at startup with `spawn hermes ENOENT` — but runs fine by hand | launchd does not inherit your shell `PATH`, so `~/.local/bin` is missing | Set `PATH` explicitly in the launchd plist (Step 8) |
| A voice question starts tools but never gives an answer or task receipt | Hermes ignored the prompt-only 15s delegation rule; the single ACP session stayed blocked until cancel/timeout | Server-enforced long-turn handoff now returns a receipt at 15s, detaches that ACP session as the background worker, and opens a fresh brain for conversation |
| `502` through the Tailscale URL | Tunnel is up, but nothing is listening on 8787 behind it | Check the server is actually running — `lsof -ti:8787` |

## Voice long-turn reliability contract

### What / when / why

As of **2026-08-07**, every real Hermes voice turn has a server-enforced response boundary. A turn that finishes before 15 seconds follows the normal answer path. A turn still active at 15 seconds returns the machine receipt `TASK-ACCEPTED <voice-handle>` (rendered as a short natural sentence by the mouth), maps that handle to the full ACP session in the audit log, keeps the original work running, and announces its final answer when that work resolves.

This repairs the production incident recorded in `~/.405network/logs/talkserver.log` at `2026-08-06T21:37:53Z`: a model-latency question triggered foreground skill/file searches, including three 20.8s failed reads and a 60.5s search. No receipt was emitted; barge-in cancelled the shared ACP session, and `/turn` eventually failed at the five-minute protocol timeout. A prompt telling the model to delegate was policy, not an enforcement mechanism.

### First principles and plan

- Spoken dead air is a user-visible failure; a filler is not a task receipt.
- The work already running is the source of truth. Do not duplicate, suppress, or fake it.
- `Promise.race` selects the foreground response boundary but does not cancel the losing work promise.
- Once a turn is backgrounded, the application issues a real `voice-<8 hex>` task handle, records its mapped ACP session, and detaches that ACP child from the foreground slot. A replacement foreground ACP child starts immediately, so new speech never queues behind or cancels the detached task.
- Desired state: quick answer inline; slow answer acknowledged by 15s; completion spoken later; unrelated turns remain available.
- Undesired state: one shared ACP child remains occupied, barge-in cancels the work, or the caller waits for the 300s `session/prompt` timeout.
- Out of scope: changing the Hermes model, hiding tool failures, weakening the 15s contract, or making process-local ACP work survive a machine restart. Durable work still belongs in Hermes cron/background-terminal facilities.

```text
voice transcript
      |
      v
Hermes ACP prompt ----- finishes <15s -----> normal spoken answer
      |
      +---- still active at 15s
                 |
                 +--> TASK-ACCEPTED <voice handle> --> natural spoken receipt
                 |
                 +--> detach busy ACP child ------> fresh foreground brain
                 |
                 +--> original work completes ----> TASK-DONE audit + announcement
```

The 15-second clock begins when `/turn` receives the transcript and includes ACP acquisition and rotation. At boot the server warms one foreground `hermes -p voice acp` child; it creates a replacement only when the foreground child becomes detached, busy, dead, or stuck. Replacement children skip the extra bootstrap model turn because the application itself enforces the voice contract; this keeps unrelated speech inside the response boundary without permanently attaching two ACP processes to the same profile. Barge-in sends `session/cancel` only to the busy foreground child, waits up to two seconds for `stopReason: cancelled`, and replaces only that child if cancellation does not settle. A speech-start event racing the 15-second boundary detaches the elapsed turn instead of cancelling it. Detached background children are not cancellation targets for unrelated new speech.

The browser serializes say-exactly injections: a completion that arrives while another answer is playing waits for `response.done`. The server keeps a matching FIFO audit receipt so concurrent answers retain the correct question and provenance instead of being mixed or attributed to the latest global turn.

### Where / operate / data and privacy

- Runtime: `talk-server.js`
- ACP prompt-lane ownership: `src/acp-client.js` (synchronous busy reservation prevents concurrent HTTP turns from sharing one client)
- Promise boundary: `src/background-turn.js`
- Regression gate: `tests/m4/t4.test.mjs` and `tests/m4/t4.sh`
- Browser acceptance rig: `tests/rig/driver.mjs --url https://sudos-imac.tailddc886.ts.net` uses the real HTTPS page, fake Chromium microphone, browser STT, Hermes, and audible TTS; its traffic is explicitly labeled `synthetic test input/output` and must never be attributed to V.
- Lifecycle evidence: `logs/background-turns.log` (`accepted`, `completed`, `failed`; handle, timing, status, and character count only — no raw user prompt or answer)
- Existing full conversation record: `logs/voice-audit.log`; permissions and retention are unchanged.
- Start/recover through `watchdog.sh` under `com.405network.talkserver`; do not run a competing listener.
- Health: `bash scripts/voice-healthcheck.sh`; deep Azure proof: `VOICE_DEEP=1 bash scripts/voice-healthcheck.sh`.

### Verify, failure behavior, and rollback

Positive verification:

```bash
node --test tests/m4/t4.test.mjs
bash tests/m4/t4.sh
bash scripts/voice-healthcheck.sh
```

Production proof must cover five distinct end-user browser scenarios: (1) a normal question answers audibly, (2) a successful read-only tool question answers audibly, (3) real work exceeding 15 seconds receives an audible receipt and later announces completion, (4) an unrelated question answers while that task remains active, and (5) a failed or stuck foreground worker produces an audible bounded failure, cancellation/replacement proof, no stale speech, and a successful follow-up. Confirm each scenario across the browser event capture, `turns.log`, `turns-routed.log`, `voice-audit.log`, `background-turns.log`, and `cancel.log`.

**2026-08-07 production qualification:** six HTTPS browser/microphone-path scenarios passed from `https://sudos-imac.tailddc886.ts.net/`; captures are retained under `/tmp/hermes-voice-e2e-20260807T142326Z/finalq-test*-events.json`. The normal answer and read-only terminal answer completed in 8.4s and 11.3s; an 18-second terminal task produced its receipt at 15.0s and announced completion; an unrelated `3 + 3` turn completed in 10.2s while the original task was still active; a failing Hermes command produced a faithful spoken failure in 5.9s; and a deliberately frozen listener-owned ACP child timed out cancellation, was replaced, emitted no stale reply, and answered the follow-up in 12.1s. These are synthetic browser-microphone inputs, not V's speech.

Negative verification: invalid auth must still fail closed with HTTP 403; a failed detached task must record `failed` and speak a short failure notice rather than disappear. A process PID or HTTP 200 alone is not proof.

Safe rollback: revert `talk-server.js`, `src/background-turn.js`, and the M4.T4 test files together, then let the owning watchdog restart the listener. Rollback restores the old prompt-only delegation behavior and therefore reintroduces the known dead-air risk; preserve `background-turns.log` as incident evidence.

#### 2026-08-08 failure-replacement addendum

**What / when / why:** An active M2.T2 production-path run at `2026-08-08T09:46Z` killed the listener-owned ACP child and correctly produced the spoken fallback plus HTTP 502, but the immediate `RECOVERY ONLINE` follow-up crossed the 15-second boundary. The error handler only cleared the dead brain; the next request therefore paid for ACP initialization *and* the bootstrap model turn before its own prompt. Recovery was observable but not ready before the next utterance.

**First principles and plan:** A spoken failure is only half of recovery. Replacement must start at the failure boundary, and an application-enforced replacement must not repeat a model bootstrap turn. The smallest repair starts a `failure-replacement` ACP child immediately, reuses the existing `brainStarting` rendezvous for overlapping follow-ups, and leaves boot-time bootstrap behavior unchanged. Failure cleanup is owner-scoped: a stale failed turn cannot clear or replace a newer brain installed by concurrent speech.

```text
listener-owned ACP dies mid-turn
          |
          +--> spoken fallback + HTTP 502
          |
          +--> start failure-replacement ACP (no bootstrap model turn)
                         |
next speech ------------+--> await same warm-up --> prompt --> spoken answer
```

**Sources and verification:** Hermes ACP process/session behavior remains as documented in the official ACP host-integration and ACP-internals references above. Node.js `/nodejs/node` documentation was consulted on 2026-08-08 for explicit async rejection handling and child-process signal semantics. Positive verification is the M2.T2 fresh-child follow-up plus shallow/deep health; negative verification is the listener-scoped child termination producing RFC 9457 HTTP 502 with `fallbackSpoken: true`. Roll back this addendum with `/Users/sudo/HermesVoiceBackups/watchdog-followup-20260808T094730Z/ROLLBACK.txt`; restoring it reintroduces next-utterance cold recovery.

#### 2026-08-09 speech-audit queue addendum

**What / when / why:** A production HTTPS browser run at `2026-08-09T00:27Z` spoke the correct `Watchdog Live Path online` response, but `voice-audit.log` paired it with an older server-only `BUS online` turn and marked the mouth as diverged. The server queued every successful `/turn` response as expected speech even when no SSE browser was connected, so direct recovery probes left undeliverable receipts that contaminated the next real browser audit.

**First principles and plan:** An audit receipt can describe audible output only when a live browser was eligible to receive the matching SSE `speak` command. Keep disconnected server-only turns in `turns.log` and `turns-routed.log`, but do not enqueue them for `/spoken` correlation. Centralize that listener-count gate so normal replies, failure announcements, and background completions share the same rule; preserve FIFO order for actually delivered speech.

```text
server-only /turn, zero SSE clients --> route/log --> no expected-speech receipt
                                                     |
live browser connects --> transcript --> Hermes --> SSE speak --> queue receipt
                                                     |
                                               POST /spoken
                                                     |
                                             faithful audit row
```

**Sources, verification, and rollback:** Node.js official `/nodejs/node` HTTP documentation was queried through Context7 on 2026-08-09: a response `close` event reflects completion or premature connection termination, so delivery accounting must follow currently connected response objects. Unit verification is `node --test tests/m4/t4.test.mjs`, including the zero-client negative and one-client positive queue cases. Production verification is a disconnected synthetic `/turn` immediately followed by a labeled synthetic HTTPS browser-microphone turn; the browser must transcribe and speak the second phrase, and the newly appended audit row must pair that same question and answer with verdict `faithful`. Roll back with `/Users/sudo/HermesVoiceBackups/watchdog-audit-queue-20260809T003012Z/ROLLBACK.txt`; do not restore port `8443`.

#### 2026-08-09 listener-preserving ACP recovery addendum

**What / when / why:** At `2026-08-09T02:07:03Z`, the active M2.T2 adverse scenario terminated only the port-8787 listener's ACP child. The application immediately started its replacement, but the outer 30-second watchdog sampled the brief childless interval, classified `components=voice_acp`, and killed the otherwise healthy listener. The RFC 9457 failure response succeeded, but the immediate recovery turn was severed and the five-test gate failed. This was a monitor/action race, not an ACP replacement failure.

**First principles and plan:** The application owns individual ACP workers; the outer watchdog owns the whole stack. A single worker failure must therefore get a short opportunity to converge in place, while a persistent missing worker and every listener, local-app, Tailscale, remote-HTTPS, or Azure-token fault must remain fail-closed. The watchdog now gives only the exact isolated `VOICE_HEALTH_FAIL components=voice_acp` state five fast process-presence probes over ten seconds, then requires the complete health gate before accepting recovery. An in-place child recovery preserves the listener; exhaustion, failed full-health confirmation, or any different initial failure takes the unchanged full-stack recovery path.

```text
listener healthy + ACP child exits
              |
              +--> talk-server starts replacement child
              |
watchdog sees exact voice_acp-only gap
              |
              +--> child returns within <=10s --> preserve listener
              |
              +--> still absent / other fault --> full-stack recovery
```

**Sources and verification:** The GNU Bash reference was queried through Context7 on 2026-08-09 for command substitution, conditional exit status, exact tests, and `pipefail`; the existing official Hermes ACP sources remain authoritative for child/session ownership. Positive verification is `bash tests/watchdog-healthcheck.sh` plus the active M2.T2 failure/replacement scenario proving the listener PID is unchanged and the next turn says `RECOVERY ONLINE`. Negative verification requires a persistent `voice_acp` failure to invoke full recovery after exactly five bounded checks, while a non-ACP failure invokes it immediately. Backup and rollback: `/Users/sudo/HermesVoiceBackups/watchdog-acp-grace-20260809T020824Z/ROLLBACK.txt`. Rollback removes the grace and reintroduces the monitor/action race; it must not alter the Tailscale route or add `:8443`.

#### 2026-08-12 pre-warmed ACP failover addendum

**What / when / why:** An active production M2.T2 run at `2026-08-12T14:39Z` terminated the exact foreground ACP child and correctly returned the spoken RFC 9457 failure fallback, but the replacement process took about 23 seconds to initialize. The immediate `RECOVERY ONLINE` follow-up therefore crossed the 15-second boundary, returned a task receipt, and completed later instead of answering inline. Skipping the bootstrap model turn was insufficient because process and session initialization themselves were cold.

**First principles and plan:** Failure recovery must not depend on optimistic cold-start latency. The listener now owns one active foreground ACP child and one idle, independently initialized failover child. Failure, cancellation replacement, background handoff, or concurrent rotation atomically promotes the ready failover, records its exact PID/session as foreground, and replenishes the standby asynchronously. Only the affected worker is terminated; the listener and sibling survive. The failover receives no bootstrap model turn, carries no user prompt until promoted, and never changes credentials, routes, thresholds, or Hermes installation files.

```text
                         +--> active foreground ACP -- failure --> stop affected child
browser speech --> listener                                      |
                         +--> warm idle ACP <----- promote -------+
                                  |
                                  +--> replenish new warm standby
```

**Sources, verification, and rollback:** The official Hermes ACP host and internals documentation confirms the stdio server, `session/new`, `session/prompt`, per-session agent state, and persisted session lifecycle. Node.js official `/nodejs/node` child-process documentation was queried through Context7 on 2026-08-12: `exit` identifies the direct child lifecycle, while `close` additionally waits for stdio and does not prove descendant termination. Positive verification requires the focused Node regression suite, active M2.T2 foreground-child termination with inline `RECOVERY ONLINE`, unchanged listener PID, two listener-owned ACP children after replenishment, and shallow/deep health. Negative verification requires the killed PID to match the foreground PID recorded by the listener; the test refuses broad or unrelated process termination. Roll back with `/Users/sudo/HermesVoiceBackups/watchdog-hot-standby-20260812T144150Z/ROLLBACK.txt`; rollback restores cold failure recovery and must not add port `8443`.

### Sources and revision history

- Hermes delegation and ACP constraints: `docs/VOICE-PLATFORM-PLAN.md` sources H9, H10, and A1–A8; official [ACP host integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/), [ACP internals](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals/), [tool reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference/), and [delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation).
- Node.js official documentation, queried through Context7 `/nodejs/node` on 2026-08-06: Promise combinators attach handlers without cancellation; child `exit` and `close` have distinct lifecycle semantics.
- Live source evidence: `~/.405network/logs/talkserver.log`, lines 1023–1047 from the 2026-08-06 incident.
- **2026-08-06:** Added deterministic 15s background handoff, detached-ACP continuation delivery, synchronous per-client prompt-lane reservation for concurrent HTTP turns, lifecycle evidence, regression coverage, production verification plan, and rollback instructions because the prompt-only delegation rule allowed a real voice turn to end without an answer or receipt. Restricted sentinel removal to leading protocol tokens so explanatory answers that mention `TASK-ACCEPTED` remain intact.
- **2026-08-07:** Made the 15-second boundary cover acquisition plus ACP work, added a spoken `voice-<8 hex>` receipt mapped to the ACP session, bounded cancellation verification/replacement, serialized overlapping speech with FIFO audit correlation, and added explicit synthetic/user provenance plus HTTPS browser-rig support. The production server keeps one warm foreground child and starts replacement children only when needed.
- **2026-08-08:** Strengthened lifecycle and failure-injection verification after the watchdog proved the old `hermes acp` process matcher did not match the deployed `hermes -p voice acp` argv. Gates now select the exact voice ACP command, and M2.T2 kills only the current port-8787 listener's direct ACP child before requiring the real `502 application/problem+json` plus spoken fallback path and a successful next turn on a fresh listener-scoped child. Synthetic `/turn` probes are explicitly labeled. The invariant gate now resolves `${HERMES_REAL_HOME}/.hermes`, passes that root explicitly to Hermes, and compares config/doctor/gateway hashes captured before each gate run; this prevents a profile-scoped shell or a legitimately evolved July baseline from producing false evidence while still failing any change made during the run. Qualification log collection is append-only: M2.T2 records the prior `turns-routed.log` line count and evaluates only newly appended telemetry instead of truncating production evidence. This changes no production routing code. Positive verification is `bash tests/m2/t2.sh` followed by normal/deep health; negative verification is the listener-scoped child outage inside M2.T2. Rollback is to restore `tests/m2/t1.sh`, `tests/m2/t2.sh`, `tests/m4/t3.sh`, `scripts/gate.sh`, and `scripts/inv.sh` from the dated pre-change backup.
- **2026-08-08:** After that adverse gate exposed a real cold-recovery race, the turn-error path now starts a no-bootstrap `failure-replacement` ACP child immediately instead of deferring all initialization to the next utterance. Replacement is tied to the exact failed owner so a stale concurrent error cannot clear a newer foreground brain. M4.T4 locks both invariants; M2.T2 is the production adverse/recovery proof. Backup and rollback: `/Users/sudo/HermesVoiceBackups/watchdog-followup-20260808T094730Z`.
- **2026-08-09:** Bound expected-speech audit receipts to the live SSE listener count. Server-only recovery probes remain fully logged but can no longer poison the FIFO used to correlate the next browser's `/spoken` receipt. Backup and rollback: `/Users/sudo/HermesVoiceBackups/watchdog-audit-queue-20260809T003012Z`.
- **2026-08-09:** Added an exact, bounded ten-second watchdog grace for only the transient listener-owned `voice_acp` replacement state. Persistent ACP loss and every other health failure retain full-stack fail-closed recovery. Backup and rollback: `/Users/sudo/HermesVoiceBackups/watchdog-acp-grace-20260809T020824Z`.
- **2026-08-12:** Added a pre-warmed, listener-owned ACP failover because an active foreground-child termination proved cold process/session initialization could exceed the 15-second follow-up contract even with bootstrap skipped. Foreground state now records the exact PID for scoped adverse testing, promotion preserves the listener, and a fresh standby is replenished after each use. Backup and rollback: `/Users/sudo/HermesVoiceBackups/watchdog-hot-standby-20260812T144150Z`.

## ELI5 glossary

- **Realtime model** — an AI that hears sound and speaks sound directly, like a phone call (no typing middleman)
- **VAD (voice activity detection)** — the "polite pause" detector: notices when you stop talking so the model knows it's its turn
- **Barge-in** — interrupting it mid-sentence and having it actually stop (like a real conversation)
- **Ephemeral key** — a 1-minute guest pass, so your house keys (real credential) never leave the server
- **SDP exchange** — the browser and Azure swap "here's how to call me" notes, then open a direct line
- **PCM 24kHz/16-bit/mono** — raw uncompressed audio: 24,000 measurements of the sound wave per second

## Sources (all first-party)

- [Realtime API via WebSockets — GA quickstart](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-websockets)
- [Realtime API via WebRTC — GA how-to](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-webrtc)
- [Realtime audio events reference](https://learn.microsoft.com/azure/foundry/openai/realtime-audio-reference)
- [Preview → GA migration guide](https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-preview-api-migration-guide)
- [Supported voices](https://learn.microsoft.com/azure/foundry/openai/audio-completions-quickstart#input-requirements) (marin & cedar are the newest generation)
- OpenAI [Realtime conversations guide](https://developers.openai.com/docs/guides/realtime-conversations) — interruption/truncation semantics

---

## Appendix A — the mistakes we actually hit

Kept because the debugging *is* the lesson:

1. **The tenant trap.** Our az CLI default account was a service principal in tenant A; the Foundry resource lived in tenant B where only a cached user login worked. `DefaultAzureCredential` happily minted a wrong-tenant token → opaque 400 on the WS handshake (not even a 401). Forcing `AZURE_TENANT_ID` made it *worse* (`AADSTS700016`). Diagnosis that cracked it: **decode the JWT** (`tid`, `upn`, `idtyp` claims) and look at who the token is actually for. Fix: mint with `--subscription`, pass it in as `AZURE_TOKEN`.
2. **curl "404" that wasn't.** Probing the WS endpoint with curl returned 404 — because HTTP/2 doesn't do WebSocket upgrades. `--http1.1` → `101 Switching Protocols`. Trust protocol details before error codes.
3. **The missing microphone.** `NotFoundError` from `getUserMedia` looked like a permissions bug. It was a Mac mini. It has no mic. Check hardware first (`system_profiler SPAudioDataType`).
4. **"It stops talking but the text keeps going."** Not a bug — transcript deltas stream at generation speed, faster than audio plays. On barge-in, Azure cuts the audio and truncates the model's context to what you actually heard; the extra text on screen was already delivered. UI fix: freeze the line on `output_audio_buffer.cleared`.
5. **Interruption is a product decision, not a constant.** `interrupt_response: true/false` flips between "stops when you speak" and "always finishes its thought." We flipped it both ways before landing on `true`. Decide what *your* app should do on purpose.
