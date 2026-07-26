#!/bin/bash
# M4.T1 — Delegation contract with hermes [H9]
# Machine contract: hermes must emit literal TASK-ACCEPTED/RUNNING/DONE <handle>
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
num() { local v="${1:-}"; [ -n "$v" ] && echo "$v" || echo 0; }
ok()  { echo "  PASS m4.t1.$1: $2"; }
bad() { echo "  FAIL m4.t1.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

route() {  # route "<transcript>" -> spoken reply text
  curl -s -X POST http://localhost:8787/turn -H "X-Voice-Auth: $AUTH" \
    -H 'Content-Type: application/json' --max-time 240 \
    -d "{\"item_id\":\"t$RANDOM\",\"transcript\":$(jq -Rn --arg t "$1" '$t'),\"route\":true}" \
    | jq -r '.spoken // ""'
}

# 1. Immediate ack: a 60s background task returns TASK-ACCEPTED fast, and does
#    NOT return the result inline.
START=$(date +%s)
R1=$(route "Start a background task that sleeps for 60 seconds then reports done. Do not wait for it — acknowledge immediately.")
ELAPSED=$(( $(date +%s) - START ))
if echo "$R1" | grep -q "TASK-ACCEPTED" && ! echo "$R1" | grep -q "TASK-DONE" && [ "$ELAPSED" -lt 60 ]; then
  HANDLE=$(echo "$R1" | grep -oE 'TASK-ACCEPTED [A-Za-z0-9_.:-]+' | head -1 | awk '{print $2}')
  echo "$HANDLE" > /tmp/m4-handle.txt
  ok 1 "acked in ${ELAPSED}s with handle ${HANDLE:-none}, no result inline"
else
  bad 1 "elapsed=${ELAPSED}s reply=$(echo "$R1" | head -c 160)"
fi

# 2. Status truth: RUNNING while in flight, DONE after it finishes — same handle
HANDLE=$(cat /tmp/m4-handle.txt 2>/dev/null || echo "")
R2=$(route "What is the status of task $HANDLE? Answer with the TASK- sentinel only.")
sleep 65
R3=$(route "What is the status of task $HANDLE now? Answer with the TASK- sentinel only.")
if echo "$R2" | grep -q "TASK-RUNNING" && echo "$R3" | grep -q "TASK-DONE"; then
  ok 2 "RUNNING then DONE for handle $HANDLE"
else
  bad 2 "mid=$(echo "$R2" | head -c 80) after=$(echo "$R3" | head -c 80)"
fi

# 3. Voice never blocked: an unrelated turn must answer well before the
#    background task could have finished. If the turn were queued behind it,
#    dt would be ~45s; unblocked turns run at normal hermes latency (observed
#    3.6-9.6s medians across M0 runs, tail to ~30s). A 35s ceiling separates
#    those cleanly. The old bound (2x the baseline median, captured minutes
#    earlier under different load) measured machine noise, not blocking: it
#    failed a CORRECT 10s answer against a 9s limit.
TASK_SECS=45
LIMIT=$(( TASK_SECS - 10 ))
route "Start another background task that sleeps $TASK_SECS seconds. Acknowledge immediately." > /dev/null
T0=$(date +%s)
R4=$(route "What is two plus two? Answer with just the number.")
DT=$(( $(date +%s) - T0 ))
if echo "$R4" | grep -q "4" && [ "$DT" -le "$LIMIT" ]; then
  ok 3 "unrelated turn answered in ${DT}s (limit ${LIMIT}s; blocked would be ~${TASK_SECS}s)"
else
  bad 3 "dt=${DT}s limit=${LIMIT}s reply=$(echo "$R4" | head -c 80)"
fi

exit $FAIL
