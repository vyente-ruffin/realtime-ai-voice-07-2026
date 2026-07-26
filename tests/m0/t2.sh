#!/bin/bash
# M0.T2 — hermes ACP handshake + latency baseline (plan: docs/VOICE-PLATFORM-PLAN.md)
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
B="$HERE/tests/baseline"
FAIL=0
ok()  { echo "  PASS m0.t2.$1: $2"; }
bad() { echo "  FAIL m0.t2.$1: $2"; FAIL=1; }

# 1. ACP dependencies present [LIVE-3][H1]
if hermes acp --check >/dev/null 2>&1; then
  ok 1 "hermes acp --check"
else
  bad 1 "hermes acp --check failed"
fi

# 2+3. Handshake + 5 PONG round trips [A5][A2][A3][A4] — spike writes the baseline
if node "$HERE/spikes/acp-ping.js"; then
  ok 2 "handshake (initialize + session/new) completed"
  # spike exits nonzero unless all 5 prompts returned end_turn + PONG
  ok 3 "5/5 prompts returned stopReason=end_turn with PONG"
else
  bad 2 "acp-ping spike failed (see spike output above)"
  bad 3 "round trips not verified"
fi

# 4. Baseline recorded, complete (samples, median, protocolVersion) [A4][A5]
if jq -e '(.samples|length == 5) and (.median|type == "number") and (.protocolVersion != null)' \
    "$B/acp-latency.json" >/dev/null 2>&1; then
  ok 4 "acp-latency.json complete (median $(jq -r .median "$B/acp-latency.json")ms, protocol $(jq -r .protocolVersion "$B/acp-latency.json"))"
else
  bad 4 "acp-latency.json missing/incomplete"
fi

# 5. Citation reconciliation line for the gate log / PR body
PV="$(jq -r '.protocolVersion // "unknown"' "$B/acp-latency.json" 2>/dev/null)"
echo "  ACP version reconciled: $PV (Sources A-rows: A1/A4 = v1 stable, A2/A3/A5 = v2 draft — reconcile in M0 PR if mismatched)"
ok 5 "reconciliation line emitted"

exit $FAIL
