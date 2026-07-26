#!/bin/bash
# M4.T3 — Hang-up fallback via hermes' own delivery machinery [LIVE-11][H9]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
num() { local v="${1:-}"; [ -n "$v" ] && echo "$v" || echo 0; }
ok()  { echo "  PASS m4.t3.$1: $2"; }
bad() { echo "  FAIL m4.t3.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

# 1. Handoff issued on session end while a task is pending
: > "$HERE/logs/handoff.log"
curl -s -X POST http://localhost:8787/session-end -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"pendingTasks":["probe-1"]}' --max-time 240 >/dev/null
ISSUED=$(grep -c '"event":"handoff-prompt"' "$HERE/logs/handoff.log" 2>/dev/null | head -1)
if [ "$(num "$ISSUED")" -ge 1 ]; then
  ok 1 "handoff prompt issued to hermes on session end"
else
  bad 1 "no handoff prompt logged"
fi

# 2. Delivery evidenced: hermes confirms it scheduled delivery, and the
#    evidence entry (message id / screenshot) is recorded per the plan's
#    Section-3 exception for external platforms.
CONFIRMED=$(grep -c '"event":"handoff-confirmed"' "$HERE/logs/handoff.log" 2>/dev/null | head -1)
EVIDENCE=$(jq -r '.evidence // empty' "$HERE/logs/handoff-evidence.json" 2>/dev/null)
if [ "$(num "$CONFIRMED")" -ge 1 ] && [ -n "$EVIDENCE" ]; then
  ok 2 "delivery confirmed by hermes; evidence recorded: ${EVIDENCE:0:40}"
else
  bad 2 "confirmed=$CONFIRMED evidence=${EVIDENCE:-none}"
fi

# 3. Clean shutdown: no orphan ACP children, invariants hold
BEFORE=$(pgrep -f "hermes acp" | wc -l | tr -d ' ')
if [ "$BEFORE" -le 2 ] && bash "$HERE/scripts/inv.sh" >/dev/null 2>&1; then
  ok 3 "no orphan children ($BEFORE) and INV-1..3 pass after hang-up"
else
  bad 3 "children=$BEFORE or invariants failed"
fi

exit $FAIL
