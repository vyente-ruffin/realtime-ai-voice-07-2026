#!/bin/bash
# M2.T2 — Turn routing: ears → brain → mouth [A3][A4][A6][MS6]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
ok()  { echo "  PASS m2.t2.$1: $2"; }
bad() { echo "  FAIL m2.t2.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

# 1. Scripted e2e (no audio): text turn → hermes → /speak carries the reply.
#    Uses the /turn test hook; the page is not involved.
RESP=$(curl -s -X POST http://localhost:8787/turn \
  -H "X-Voice-Auth: $AUTH" -H 'Content-Type: application/json' \
  -d '{"item_id":"test-1","transcript":"Reply with exactly: BUS ONLINE","route":true}' \
  --max-time 180)
if echo "$RESP" | jq -e '.spoken | test("BUS ONLINE"; "i")' >/dev/null 2>&1; then
  ok 1 "hermes reply routed to /speak: $(echo "$RESP" | jq -r '.spoken' | head -c 60)"
else
  bad 1 "no BUS ONLINE in routed reply: $(echo "$RESP" | head -c 200)"
fi

# 2. 🗣️(synthetic) spoken e2e through the real page + rig
bash "$HERE/tests/rig/make-wav.sh" /tmp/m2t2.wav "Say the words bus online." >/dev/null
if node "$HERE/tests/rig/driver.mjs" --wav /tmp/m2t2.wav --puppet 1 --watch 60 --out /tmp/m2t2.json; then
  SPOKEN=$(jq -r '[.events[]|select(.type=="response.output_audio_transcript.done")]|map(.text)|join(" ")' /tmp/m2t2.json)
  if echo "$SPOKEN" | grep -qi "bus online"; then
    ok 2 "spoken reply contains 'bus online'"
  else
    bad 2 "spoken transcripts lacked it: $(echo "$SPOKEN" | head -c 120)"
  fi
else
  bad 2 "rig run failed"
fi

# 3. Latency telemetry: numeric turn_ms logged for 3 consecutive routed turns
: > "$HERE/logs/turns-routed.log"
for i in 1 2 3; do
  curl -s -X POST http://localhost:8787/turn -H "X-Voice-Auth: $AUTH" \
    -H 'Content-Type: application/json' \
    -d "{\"item_id\":\"lat-$i\",\"transcript\":\"Reply with exactly: OK$i\",\"route\":true}" \
    --max-time 180 > /dev/null
done
NUMERIC=$(grep -c '"turn_ms":[0-9]' "$HERE/logs/turns-routed.log" 2>/dev/null || echo 0)
if [ "$NUMERIC" -ge 3 ]; then
  ok 3 "turn_ms logged numerically for $NUMERIC turns"
else
  bad 3 "only $NUMERIC numeric turn_ms entries (want >= 3)"
fi

# 4. Failure is graceful: kill the ACP child mid-turn → problem+json 502 + fallback
(sleep 3; pkill -f "hermes acp") &
CODE=$(curl -s -o /tmp/m2t2-err.json -w "%{http_code}" -X POST http://localhost:8787/turn \
  -H "X-Voice-Auth: $AUTH" -H 'Content-Type: application/json' \
  -d '{"item_id":"kill-1","transcript":"Take your time and count slowly to twenty.","route":true}' \
  --max-time 180)
if [ "$CODE" = "502" ] && jq -e '.title and .status == 502' /tmp/m2t2-err.json >/dev/null 2>&1 \
   && jq -e '.fallbackSpoken == true' /tmp/m2t2-err.json >/dev/null 2>&1; then
  ok 4 "problem+json 502 with spoken fallback"
else
  bad 4 "code=$CODE body=$(head -c 160 /tmp/m2t2-err.json)"
fi

exit $FAIL
