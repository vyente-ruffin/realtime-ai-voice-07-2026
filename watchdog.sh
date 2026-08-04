#!/bin/bash
# Keeps the voice stack online: Tailscale (tunnel + HTTPS) and talk-server.
# launchd keeps this script alive; this script keeps the two pieces alive.
# Runs under the login session — see com.405network.talkserver.plist.

REPO="/Users/sudo/GIT/405network/foundry/realtime-audio-quickstart-js"
PORT=8787
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
LOG="$HOME/.405network/logs/talkserver-watchdog.log"

mkdir -p "$(dirname "$LOG")"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

say "watchdog started (pid $$)"

while true; do
  # 1. Tailscale up? Without it the tunnel and its HTTPS cert are gone.
  if ! "$TS" status >/dev/null 2>&1; then
    say "tailscale down -> bringing up"
    "$TS" up >/dev/null 2>&1 && say "tailscale up" || say "tailscale up FAILED"
  fi

  # 2. serve config present? Survives restarts, but re-assert if tailscaled
  #    came back without it.
  if "$TS" status >/dev/null 2>&1 && ! "$TS" serve status 2>/dev/null | grep -q "$PORT"; then
    say "serve config missing -> re-adding"
    "$TS" serve --bg "$PORT" >/dev/null 2>&1 && say "serve restored" || say "serve FAILED"
  fi

  # 3. voice server listening?
  if ! lsof -ti:"$PORT" >/dev/null 2>&1; then
    say "talk-server down -> starting"
    cd "$REPO" || { say "repo missing: $REPO"; sleep 30; continue; }
    AZURE_OPENAI_ENDPOINT=https://ai103-resource-ruffin.openai.azure.com \
    AZURE_OPENAI_DEPLOYMENT_NAME=gpt-realtime-2.1 \
      nohup node talk-server.js >> "$HOME/.405network/logs/talkserver.log" 2>&1 &
    say "talk-server spawned (pid $!)"
  fi

  sleep 30
done
