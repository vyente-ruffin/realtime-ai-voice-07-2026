# Private phone preview — installed

Live private URL: `https://hermesubuntuv1.tailddc886.ts.net:8443/`.

This preview uses the existing web app with the new voice implementation. It has a separate Hermes worker profile and local state file. It reads the existing personal Hindsight bank through its supported interface and saves the user's actual new conversation there. Qualification audio and fictional memories are excluded. The normal voice app on port 443/8787 and the `/docs` route remain as they are.

The user explicitly approved this exact private preview and personal-memory access on 2026-09-21. It was installed at 23:33 UTC using `npm run setup:live -- --install`. The isolated worker profile and personal `jarvis-voice-context` summary are prepared, `voice-live-preview.service` is active, and the private HTTPS route is live. The original app, original profile configuration and existing routes remain unchanged. No public Funnel was enabled. Hermes and Hindsight source remain unchanged. The earlier automatic-approval rejection is resolved by this explicit approval. Installation records are in `/home/localadmin/.local/state/jarvis-voice/install-20260921T233334Z/`.

## Built setup command

`npm run setup:live -- --check` checks local prerequisites without modifying profiles, memories, services or routes. `npm run setup:live -- --install` performs the preparation and private-preview installation below, verifies that existing routes and the original profile remain unchanged, and records the installation in `~/.local/state/jarvis-voice/`. It does not enable boot startup or replace production. A readiness/route failure stops the preview and removes only the route it added. Approval for this exact private destination and its personal-memory access has been granted. The installer refuses to replace an already active preview or existing port-8443 route; use the removal steps before a fresh installation.

## Installation steps performed

1. Set the isolated profile's `agent.environment_hint` to the background-worker contract used by the voice app, with no qualification persona. Copy the existing voice profile's Hindsight configuration to this isolated profile with mode 0600. Keep the original files unchanged.
2. Run `HINDSIGHT_CONFIG_PATH=/home/localadmin/.hermes/profiles/voice-live-preview/hindsight/config.json node scripts/prepare-voice-memory.mjs` from the candidate worktree. This creates a voice-owned summary using Hindsight’s built-in refresh after consolidation, with updates coalesced within five minutes. Existing weekly personal/work summaries remain unchanged. Then save the existing front-end unit and `tailscale serve status --json` in the private release evidence directory. Confirm the port-443 handlers still point `/` to 8787 and `/docs` to 8790.
3. Ensure `voice-live-qualification.service` is stopped. Install this prepared unit under `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, then `systemctl --user start voice-live-preview.service`. Do not enable it for boot.
4. Check local `/healthz`, prepared memory availability and the ready worker. Add only `tailscale serve --bg --https=8443 http://127.0.0.1:8789`. Confirm the port-443 handlers are unchanged and test the new HTTPS page without making a synthetic voice call to the personal bank.
5. On the actual phone, try an opening greeting, a known personal fact, and a background request followed by an unrelated question. Record phone/browser, missed replies, task-card state, and whether the result is spoken once. Complete the remaining original scorecard checks before any production rollout.

## Remove the preview

Run `tailscale serve --https=8443 off` to remove only the preview listener, then `systemctl --user stop voice-live-preview.service`. Preserve its state file and any task outcomes. Do not reset Tailscale Serve: that would remove production routes. Production itself needs no rollback because this preview does not replace it.

Production rollout is still prohibited while required checks fail or remain unverified. The intended production rollback keeps the original entry point, service settings, Azure deployment, and app revision recorded in the release evidence; preserve the candidate state rather than rerunning uncertain actions.
