# Private phone preview — awaiting approval

Prepared URL: `https://hermesubuntuv1.tailddc886.ts.net:8443/`.

This preview uses the existing web app with the new voice implementation. It has a separate Hermes worker profile and local state file. It reads the existing personal Hindsight bank through its supported interface and saves the user's actual new conversation there. Qualification audio and fictional memories are excluded. The normal voice app on port 443/8787 and the `/docs` route remain as they are.

Automatic approval review rejected copying the personal memory configuration, starting this preview service, and adding the private HTTPS route. Its reason was that personal data exposure to the new network destination and the persistent route lacked explicit authorization. The preview has not been started or exposed. The supported CLI already created the isolated `voice-live-preview` profile; its memory configuration and worker-role hint still need preparation after approval. Hermes and Hindsight source remain unchanged.

## After explicit approval

1. Set the isolated profile's `agent.environment_hint` to the background-worker contract used by the voice app, with no qualification persona. Copy the existing voice profile's Hindsight configuration to this isolated profile with mode 0600. Keep the original files unchanged.
2. Run `HINDSIGHT_CONFIG_PATH=/home/localadmin/.hermes/profiles/voice-live-preview/hindsight/config.json node scripts/prepare-voice-memory.mjs` from the candidate worktree. This creates a voice-owned summary using Hindsight’s built-in refresh after consolidation, with updates coalesced within five minutes. Existing weekly personal/work summaries remain unchanged. Then save the existing front-end unit and `tailscale serve status --json` in the private release evidence directory. Confirm the port-443 handlers still point `/` to 8787 and `/docs` to 8790.
3. Ensure `voice-live-qualification.service` is stopped. Install this prepared unit under `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, then `systemctl --user start voice-live-preview.service`. Do not enable it for boot.
4. Check local `/healthz`, prepared memory availability and the ready worker. Add only `tailscale serve --bg --https=8443 http://127.0.0.1:8789`. Confirm the port-443 handlers are unchanged and test the new HTTPS page without making a synthetic voice call to the personal bank.
5. On the actual phone, try an opening greeting, a known personal fact, and a background request followed by an unrelated question. Record phone/browser, missed replies, task-card state, and whether the result is spoken once. Complete the remaining original scorecard checks before any production rollout.

## Remove the preview

Run `tailscale serve --https=8443 off` to remove only the preview listener, then `systemctl --user stop voice-live-preview.service`. Preserve its state file and any task outcomes. Do not reset Tailscale Serve: that would remove production routes. Production itself needs no rollback because this preview does not replace it.

Production rollout is still prohibited while required checks fail or remain unverified. The intended production rollback keeps the original entry point, service settings, Azure deployment, and app revision recorded in the release evidence; preserve the candidate state rather than rerunning uncertain actions.
