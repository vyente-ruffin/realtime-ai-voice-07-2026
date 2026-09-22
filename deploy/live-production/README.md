# Current voice version and rollback

The user requested that the researched build replace the existing app after being told the outstanding speed and interruption failures. The switch completed at 2026-09-21 23:49 UTC. This was an explicit rollout decision; the original acceptance results have not been relabelled as passing.

At that cutover, the normal address, `https://hermesubuntuv1.tailddc886.ts.net/`, served GPT-Live build `cef1bf62525899d7`. Source at cutover: `64b2349a30454d2c0668cd89aa2d311a8867ae1b`. The `voice-frontend.service` drop-in at `~/.config/systemd/user/voice-frontend.service.d/50-jarvis-live.conf` points to this checkout and the existing personal worker/memory configuration. The original unit remains in place. `/docs` is unchanged. The former preview address on port 8443 is an alias to the same service on 8787; its separate service is stopped. Only one service uses the personal state file.

The switch waited for no active jobs and a pause in conversation. The personal SQLite state was backed up and retained: one conversation, 265 transcript fragments, two completed jobs, six completed memory writes and two result-delivery records. The user had already tried this build and received personal answers and background results. Actual phone/Bluetooth/lock-screen acceptance and the original performance targets remain separate requirements.

Deployment records, original service settings, routes, state backup and health checks: `/home/localadmin/.local/state/jarvis-voice/production-20260921T234934Z/`.

## Settings update, 2026-09-22

Current build: `5281aa0bf099c390`, source commit `afbc8d4471088d99ebbf4481fc373a6f5b547d6f`. Restored persona presets, custom instructions, voice selection, speaking-pace preferences and browser noise reduction. Pause timing remains automatic. Preferences persist in the browser and apply at the next connection. The default voice instructions are byte-for-byte unchanged; no extra model calls, Hermes changes or Hindsight changes were added.

All 14 existing focused tests passed. An isolated browser check verified settings persistence, request contents, microphone constraints, mobile layout and Start/End controls. The normal HTTPS app then passed a page/health check with the new build, prepared memories and the worker ready. These checks do not establish live speech quality or interruption timing. Deployment waited for no active jobs and 257 seconds since speech; saved state counts were preserved. Evidence: `/home/localadmin/.local/state/jarvis-voice/settings-20260922T001137Z/`.

## Prepared personal memory update

The voice now loads three existing prepared summaries: `jarvis-voice-profile`, `jarvis-voice-preferences`, and `jarvis-voice-current`. Known personal facts can be answered directly; automatic summary changes enter open conversations quietly. The voice service's checkout and `VOICE_MEMORY_MODELS` select this version. The existing state, worker profile, and public route are preserved.

Focused memory checks and all 37 regression tests passed. The older 500 ms interruption benchmark remains failed; see `docs/VOICE-MEMORY-VERIFICATION.md` for test boundaries and retained failures. Deployment was verified against the existing private website, including ready summaries/worker, exact browser files, and matching connection records in SQLite and the existing service log.

Only the voice service was restarted, after checking idle status and preserving its state and prior settings. Hermes and Hindsight remained unchanged. Roll back this update by restoring the privately saved prior voice drop-in while idle, reloading systemd, and restarting only the voice service. Preserve the current state file. Existing browser tabs load the new script on refresh. Detailed deployment evidence stays in local private storage; Graylog receipt is unverified.

## Rollback

Wait for active work to finish. Stop `voice-frontend.service`, remove only `~/.config/systemd/user/voice-frontend.service.d/50-jarvis-live.conf`, run `systemctl --user daemon-reload`, then start `voice-frontend.service`. The untouched original checkout at `/home/localadmin/homelab/realtime-ai-voice`, commit `9cf7105813f514553a5057933e3b63e5a3e35639`, and its `talk-server.js` entry point will run again on 8787. Verify `/healthz`. Preserve the new state file and all task outcomes; never replay uncertain actions.

If the new build should remain available as a separate preview after rollback, start `voice-live-preview.service` only after the new production process has stopped, and restore only the existing alias using `tailscale serve --bg --https=8443 http://127.0.0.1:8789`. Leave port 443 and `/docs` unchanged. No Hermes or Hindsight source rollback is needed because their source and versions were not changed.
