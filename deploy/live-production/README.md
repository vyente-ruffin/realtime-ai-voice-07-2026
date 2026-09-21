# Production cutover — prepared, not applied

Required first: the original scorecard passes, the isolated personal worker and `jarvis-voice-context` summary are prepared, and any active work on the old app or preview has finished. Do not deploy from a dirty or unqualified candidate checkout. Record the candidate commit and `/healthz` build ID with the acceptance results.

The saved original unit is `/home/localadmin/voice-implementation-evidence-2026-09-21/release/voice-frontend.service.before`. Its working directory is `/home/localadmin/homelab/realtime-ai-voice`, its entry point is `talk-server.js`, and the recorded revision is `9cf7105813f514553a5057933e3b63e5a3e35639`. There were no existing drop-ins. The original entry point and Azure Realtime deployment remain available.

The prepared drop-in changes only the app entry point and voice-specific configuration. Production keeps port 8787 and its existing private HTTPS route. The personal preview and production use the same durable state path, so promotion preserves the user's conversation and tasks. They must not run against that state file concurrently. Synthetic qualification uses a different bank and state file.

After acceptance, stop the personal preview, copy `voice-frontend-live.conf` to `/home/localadmin/.config/systemd/user/voice-frontend.service.d/50-jarvis-live.conf`, run `systemctl --user daemon-reload`, then restart `voice-frontend.service`. Verify local and existing HTTPS health and one actual spoken turn. Keep the worktree at the recorded accepted commit. No Tailscale change is required for production.

Rollback: remove only the newly installed `50-jarvis-live.conf`, reload user systemd, and restart `voice-frontend.service`. Verify the original entry point and health. The saved original unit is an additional recovery copy; do not reset Git or remove the candidate state file. If the candidate was stopped during work, treat its unfinished actions as needing checking and do not replay them.

These are prepared instructions. No production configuration has been installed or changed.
