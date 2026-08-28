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

# 6. A listener-owned ACP replacement gets a short, exact, bounded grace.
# Source only the watchdog functions; do not enter its service loop.
WATCHDOG_LIB_ONLY=1
source "$HERE/watchdog.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LOG="$TMP/watchdog.log"
ACP_GRACE_ATTEMPTS=3
ACP_GRACE_SLEEP=0
RECOVERED="$TMP/full-stack-recovery"

recover_stack() {
  : > "$RECOVERED"
  return 0
}

# Probe state is intentionally file-backed because command substitutions run in
# subshells. Scenario selects transient, persistent, or unrelated failure.
voice_acp_present() {
  local count=0
  [[ -s "$TMP/presence-count" ]] && count="$(<"$TMP/presence-count")"
  count=$((count + 1))
  printf '%s' "$count" > "$TMP/presence-count"
  [[ "${SCENARIO:-}" == "transient" && "$count" -ge 2 ]]
}

run_health() {
  local count=0
  [[ -s "$TMP/health-count" ]] && count="$(<"$TMP/health-count")"
  count=$((count + 1))
  printf '%s' "$count" > "$TMP/health-count"
  if [[ "${SCENARIO:-}" == "persistent" ]]; then
    echo 'VOICE_HEALTH_FAIL components=voice_acp'
    return 1
  fi
  if [[ "${SCENARIO:-}" == "unrelated" ]]; then
    echo 'VOICE_HEALTH_FAIL components=remote_https'
    return 1
  fi
  echo 'VOICE_HEALTH_OK local=test remote=test acp=voice deep=0'
}

SCENARIO=transient
printf '0' > "$TMP/presence-count"
printf '0' > "$TMP/health-count"
rm -f "$RECOVERED"
handle_health_failure 'VOICE_HEALTH_FAIL components=voice_acp'
[[ ! -e "$RECOVERED" ]] || fail "transient ACP replacement restarted the listener"
[[ "$(<"$TMP/presence-count")" == "2" ]] || fail "transient ACP replacement was not rechecked"
[[ "$(<"$TMP/health-count")" == "1" ]] || fail "recovered ACP did not receive full health confirmation"
pass "transient ACP replacement preserves the listener"

SCENARIO=persistent
printf '0' > "$TMP/presence-count"
printf '0' > "$TMP/health-count"
rm -f "$RECOVERED"
handle_health_failure 'VOICE_HEALTH_FAIL components=voice_acp'
[[ -e "$RECOVERED" ]] || fail "persistent ACP outage did not recover fail-closed"
[[ "$(<"$TMP/presence-count")" == "3" ]] || fail "persistent ACP grace was not bounded"
[[ "$(<"$TMP/health-count")" == "1" ]] || fail "persistent ACP recovery was not rechecked"
pass "persistent ACP outage remains fail-closed after bounded grace"

SCENARIO=unrelated
printf '0' > "$TMP/presence-count"
printf '0' > "$TMP/health-count"
rm -f "$RECOVERED"
handle_health_failure 'VOICE_HEALTH_FAIL components=remote_https'
[[ -e "$RECOVERED" ]] || fail "non-ACP failure was incorrectly deferred"
[[ "$(<"$TMP/presence-count")" == "0" ]] || fail "non-ACP failure entered ACP grace"
[[ "$(<"$TMP/health-count")" == "1" ]] || fail "non-ACP recovery was not rechecked"
pass "non-ACP failure still recovers immediately"

echo 'WATCHDOG_HEALTHCHECK_TESTS_OK'
