#!/bin/bash
# M3.T1 — Adaptive fillers, out-of-band [C1][C6][C7]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
num() { local v="${1:-}"; [ -n "$v" ] && echo "$v" || echo 0; }
ok()  { echo "  PASS m3.t1.$1: $2"; }
bad() { echo "  FAIL m3.t1.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

# The mock brain lets us control think-time exactly; real hermes latency
# varies 4-30s (M0 baseline) which cannot prove a 1.5s threshold.
# mocking is enabled server-side by gate.sh (VOICE_ALLOW_MOCK); the marker
# MOCK_DELAY_<ms> in the transcript selects the delay.

# 1. Slow reply (mock delay 4s) → filler fires between 1.5s and 3.0s
R=$(curl -s -X POST http://localhost:8787/turn -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' --max-time 60 \
  -d '{"item_id":"f1","transcript":"MOCK_DELAY_4000 say something","route":true}')
FT=$(echo "$R" | jq -r '.fillerAfterMs // empty')
if [ -n "$FT" ] && [ "$FT" -ge 1500 ] && [ "$FT" -le 3000 ]; then
  ok 1 "filler fired at ${FT}ms (window 1500-3000)"
else
  bad 1 "fillerAfterMs=${FT:-none} outside window"
fi

# 2. Fast reply (mock delay 500ms) → no filler at all
R=$(curl -s -X POST http://localhost:8787/turn -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' --max-time 60 \
  -d '{"item_id":"f2","transcript":"MOCK_DELAY_500 say something","route":true}')
if [ "$(echo "$R" | jq -r '.fillerFired')" = "false" ]; then
  ok 2 "no filler on a fast reply"
else
  bad 2 "filler fired on a fast reply: $(echo "$R" | head -c 120)"
fi

# 3. Fillers are out-of-band: tagged conversation:"none" + metadata.purpose,
#    and the text never reaches hermes' prompt context [C1][C7]
OOB=$(grep -c '"conversation":"none"' "$HERE/logs/fillers.log" 2>/dev/null | head -1)
TAGGED=$(grep -c '"purpose":"filler"' "$HERE/logs/fillers.log" 2>/dev/null | head -1)
LEAKED=$(grep -ciE "one sec|checking|let me think|still with you" "$HERE/logs/turns-routed.log" 2>/dev/null | head -1)
if [ "$OOB" -ge 1 ] && [ "$TAGGED" -ge 1 ] && [ "$LEAKED" -eq 0 ]; then
  ok 3 "fillers out-of-band ($OOB) and tagged ($TAGGED); zero leaked into prompts"
else
  bad 3 "oob=$OOB tagged=$TAGGED leaked=$LEAKED"
fi

# 4. Variety: 5 slow turns → >= 3 distinct fillers, no immediate repeats
: > "$HERE/logs/fillers.log"
for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:8787/turn -H "X-Voice-Auth: $AUTH" \
    -H 'Content-Type: application/json' --max-time 60 \
    -d "{\"item_id\":\"v$i\",\"transcript\":\"MOCK_DELAY_3000 turn $i\",\"route\":true}" > /dev/null
done
DISTINCT=$(jq -r '.text' "$HERE/logs/fillers.log" 2>/dev/null | sort -u | wc -l | tr -d ' ')
REPEATS=$(jq -r '.text' "$HERE/logs/fillers.log" 2>/dev/null | awk 'p==$0{c++} {p=$0} END{print c+0}')
if [ "$DISTINCT" -ge 3 ] && [ "$REPEATS" -eq 0 ]; then
  ok 4 "$DISTINCT distinct fillers, no immediate repeats"
else
  bad 4 "distinct=$DISTINCT immediateRepeats=$REPEATS"
fi

exit $FAIL
