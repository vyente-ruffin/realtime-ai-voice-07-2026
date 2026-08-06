#!/bin/bash
# Binary checks for the always-on voice health gate.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HC="$HERE/scripts/voice-healthcheck.sh"

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

# 1. Healthy production stack passes all layers.
out="$(bash "$HC")" || fail "healthy production stack rejected: $out"
grep -q 'VOICE_HEALTH_OK' <<<"$out" || fail "success receipt missing"
pass "healthy production stack"

# 2. A dead local backend fails closed.
if VOICE_PORT=9 bash "$HC" >/tmp/voice-hc-dead-local.out 2>&1; then
  fail "dead local backend was accepted"
fi
grep -q 'local_app' /tmp/voice-hc-dead-local.out || fail "dead local cause missing"
pass "dead local backend rejected"

# 3. A broken remote Tailscale URL fails closed.
if TAILSCALE_URL=https://127.0.0.1:9 bash "$HC" >/tmp/voice-hc-dead-remote.out 2>&1; then
  fail "dead remote URL was accepted"
fi
grep -q 'remote_https' /tmp/voice-hc-dead-remote.out || fail "dead remote cause missing"
pass "dead remote URL rejected"

# 4. A missing Hermes voice ACP child fails closed.
if ACP_PATTERN='definitely-no-such-hermes-acp-process' bash "$HC" >/tmp/voice-hc-dead-acp.out 2>&1; then
  fail "missing ACP brain was accepted"
fi
grep -q 'voice_acp' /tmp/voice-hc-dead-acp.out || fail "missing ACP cause missing"
grep -q 'pgrep -P.*LISTENER_PID' "$HC" || fail "ACP check is not scoped to talk-server child"
pass "missing ACP brain rejected and parent-scoped"

# 5. The always-on watchdog must call the fail-closed gate and recover failures.
grep -q 'voice-healthcheck.sh' "$HERE/watchdog.sh" || fail "watchdog does not invoke health gate"
grep -q 'health check failed -> restarting stack' "$HERE/watchdog.sh" || fail "watchdog has no recovery action"
pass "watchdog integrates fail-closed health gate"

echo 'WATCHDOG_HEALTHCHECK_TESTS_OK'
