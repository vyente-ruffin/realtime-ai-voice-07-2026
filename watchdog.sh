#!/bin/bash
# Keeps Sins Twin / Hermes Voice online: Tailscale HTTPS, talk-server, Azure
# token mint, and the `hermes -p voice acp` brain.
# launchd keeps this script alive; this script converges the full stack.

set -uo pipefail

REPO="/Users/sudo/GIT/405network/foundry/realtime-audio-quickstart-js"
PORT=8787
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
LOG="$HOME/.405network/logs/talkserver-watchdog.log"
HEALTH="$REPO/scripts/voice-healthcheck.sh"
INTERVAL=30
DEEP_EVERY=10                    # Azure guest-pass proof every 5 minutes
TICK=0

mkdir -p "$(dirname "$LOG")"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

ensure_tailscale() {
  if ! "$TS" status >/dev/null 2>&1; then
    say "tailscale down -> bringing up"
    "$TS" up >/dev/null 2>&1 && say "tailscale up" || say "tailscale up FAILED"
  fi
}

ensure_serve() {
  local status
  status="$("$TS" serve status --json 2>/dev/null || true)"
  if ! /usr/bin/python3 - "$status" "$PORT" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
    handlers = next(iter(d["Web"].values()))["Handlers"]
    ok = handlers["/"].get("Proxy") == f"http://127.0.0.1:{sys.argv[2]}"
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
PY
  then
    say "serve config missing/wrong -> re-adding"
    "$TS" serve --bg "$PORT" >/dev/null 2>&1 \
      && say "serve restored" || say "serve FAILED"
  fi
}

start_server() {
  cd "$REPO" || { say "repo missing: $REPO"; return 1; }
  AZURE_OPENAI_ENDPOINT=https://ai103-resource-ruffin.openai.azure.com \
  AZURE_OPENAI_DEPLOYMENT_NAME=gpt-realtime-2.1 \
    nohup node talk-server.js >> "$HOME/.405network/logs/talkserver.log" 2>&1 &
  say "talk-server spawned (pid $!)"
}

stop_server() {
  local pids
  pids="$(/usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  /bin/kill $pids 2>/dev/null || true
  for _ in {1..10}; do
    /usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    /bin/sleep 1
  done
  /bin/kill -9 $pids 2>/dev/null || true
}

wait_for_local() {
  for _ in {1..30}; do
    if /usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null \
      | /usr/bin/grep -q 'name="voice-auth"'; then
      return 0
    fi
    /bin/sleep 1
  done
  return 1
}

recover_stack() {
  say "health check failed -> restarting stack"
  ensure_tailscale
  ensure_serve
  stop_server
  start_server || return 1
  if wait_for_local; then
    say "talk-server recovered"
  else
    say "talk-server recovery FAILED"
    return 1
  fi
}

say "watchdog started (pid $$)"
while true; do
  ensure_tailscale
  ensure_serve

  if ! /usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    say "talk-server down -> starting"
    start_server
    wait_for_local || say "talk-server start health FAILED"
  fi

  TICK=$((TICK + 1))
  DEEP=0
  (( TICK % DEEP_EVERY == 0 )) && DEEP=1
  if RESULT="$(VOICE_DEEP="$DEEP" /bin/bash "$HEALTH" 2>&1)"; then
    if [[ "$DEEP" == "1" ]]; then
      say "$RESULT"
    fi
  else
    say "$RESULT"
    recover_stack
    if RESULT="$(/bin/bash "$HEALTH" 2>&1)"; then
      say "health recovered: $RESULT"
    else
      say "health still FAILED: $RESULT"
    fi
  fi

  /bin/sleep "$INTERVAL"
done
