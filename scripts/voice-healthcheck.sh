#!/bin/bash
# Fail-closed health gate for Sins Twin / Hermes Voice.
# Checks the real local app, the exact Tailscale Serve route, remote HTTPS,
# and the Hermes voice-profile ACP child. Optional VOICE_DEEP=1 also mints an
# Azure Realtime ephemeral token without printing credentials.
set -uo pipefail

PORT="${VOICE_PORT:-8787}"
TAILSCALE_URL="${TAILSCALE_URL:-https://sudos-imac.tailddc886.ts.net}"
TS="${TAILSCALE_BIN:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
CURL="${CURL_BIN:-/usr/bin/curl}"
ACP_PATTERN="${ACP_PATTERN:-hermes -p voice acp}"
LOCAL_URL="http://127.0.0.1:${PORT}"
FAILURES=()
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { FAILURES+=("$1"); }

# A listening socket alone is insufficient: require the actual application page.
LISTENER_PID="$(/usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
if [[ -z "$LISTENER_PID" ]]; then
  fail "listener"
fi

if ! "$CURL" -fsS --max-time 8 "$LOCAL_URL/" -o "$TMP/local.html" \
  || ! /usr/bin/grep -q 'name="voice-auth"' "$TMP/local.html" \
  || ! /usr/bin/grep -q '<title>Voice Lab' "$TMP/local.html"; then
  fail "local_app"
fi

# Require the exact HTTPS root proxy, not a loose grep for the port.
if ! "$TS" serve status --json >"$TMP/serve.json" 2>/dev/null; then
  fail "tailscale_serve"
else
  if ! /usr/bin/python3 - "$TMP/serve.json" "$TAILSCALE_URL" "$PORT" <<'PY'
import json, sys
from urllib.parse import urlparse
p, base, port = sys.argv[1:]
try:
    data = json.load(open(p))
    host = urlparse(base).hostname
    handler = data["Web"][f"{host}:443"]["Handlers"]["/"]
    ok = handler.get("Proxy") == f"http://127.0.0.1:{port}"
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
PY
  then
    fail "tailscale_route"
  fi
fi

# This exercises the real certificate, MagicDNS, Serve proxy, and app page.
if ! "$CURL" -fsS --max-time 12 "$TAILSCALE_URL/" -o "$TMP/remote.html" \
  || ! /usr/bin/grep -q 'name="voice-auth"' "$TMP/remote.html" \
  || ! /usr/bin/grep -q '<title>Voice Lab' "$TMP/remote.html"; then
  fail "remote_https"
fi

# The UI can look healthy while its own Hermes brain child is missing. Scope the
# check to the talk-server parent so an unrelated ACP process cannot mask failure.
if [[ -z "$LISTENER_PID" ]] \
  || ! /usr/bin/pgrep -P "$LISTENER_PID" -f "$ACP_PATTERN" >/dev/null 2>&1; then
  fail "voice_acp"
fi

# Deep check: prove Azure can still mint the WebRTC guest pass. Never print it.
if [[ "${VOICE_DEEP:-0}" == "1" ]] && [[ -s "$TMP/remote.html" ]]; then
  AUTH="$(/usr/bin/sed -n 's/.*name="voice-auth" content="\([^"]*\)".*/\1/p' "$TMP/remote.html" | head -1)"
  if [[ -z "$AUTH" ]]; then
    fail "azure_token_auth"
  else
    CODE="$("$CURL" -sS --max-time 45 -o "$TMP/token.json" -w '%{http_code}' \
      -X POST "$TAILSCALE_URL/token" \
      -H 'Content-Type: application/json' \
      -H "Origin: $TAILSCALE_URL" \
      -H "X-Voice-Auth: $AUTH" \
      -d '{"puppet":true,"voice":"cedar"}' 2>/dev/null || true)"
    if [[ "$CODE" != "200" ]] \
      || ! /usr/bin/python3 - "$TMP/token.json" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    ok = bool(data.get("ephemeralKey")) and data.get("settings", {}).get("puppet") is True
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
PY
    then
      fail "azure_token"
    fi
  fi
fi

if (( ${#FAILURES[@]} )); then
  printf 'VOICE_HEALTH_FAIL components=%s\n' "$(IFS=,; echo "${FAILURES[*]}")"
  exit 1
fi

printf 'VOICE_HEALTH_OK local=%s remote=%s acp=voice deep=%s\n' "$LOCAL_URL" "$TAILSCALE_URL" "${VOICE_DEEP:-0}"
