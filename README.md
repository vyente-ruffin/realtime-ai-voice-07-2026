# 🎙️ Realtime AI Voice — Talk to GPT Realtime on Azure AI Foundry

Build a browser page where you **talk to an AI with your voice and it talks back** — with real interruption ("barge-in"), selectable voices, and no API keys ever touching the browser. Built July 2026 against `gpt-realtime-2.1`, tested end-to-end, including every mistake we hit along the way (documented in [Appendix A](#appendix-a--the-mistakes-we-actually-hit)).

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
| `silence_duration_ms` | e.g. `500` | How long a pause means "your turn is over" |
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

Started by hand, the server dies with its terminal and nothing survives a reboot. `watchdog.sh` plus a launchd agent fixes that: it checks every 30s and restarts whichever piece is down — Tailscale, the `serve` config, or the server itself.

```bash
cp watchdog.sh <somewhere-stable>            # it references absolute paths; edit REPO/PORT at the top
launchctl load ~/Library/LaunchAgents/com.405network.talkserver.plist
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
| `502` through the Tailscale URL | Tunnel is up, but nothing is listening on 8787 behind it | Check the server is actually running — `lsof -ti:8787` |

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
