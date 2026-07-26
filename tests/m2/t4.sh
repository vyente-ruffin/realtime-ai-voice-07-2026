#!/bin/bash
# M2.T4 — Retire classic mode (scaffold teardown; north-star rule 1)
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
ok()  { echo "  PASS m2.t4.$1: $2"; }
bad() { echo "  FAIL m2.t4.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

# 1. Classic mode refused with problem+json 400
CODE=$(curl -s -o /tmp/m2t4.json -w "%{http_code}" -X POST http://localhost:8787/token \
  -H "X-Voice-Auth: $AUTH" -H 'Content-Type: application/json' -d '{"puppet":false}')
CT=$(curl -s -D- -o /dev/null -X POST http://localhost:8787/token \
  -H "X-Voice-Auth: $AUTH" -H 'Content-Type: application/json' -d '{"puppet":false}' \
  | grep -i "^content-type" | tr -d '\r')
if [ "$CODE" = "400" ] && echo "$CT" | grep -qi "application/problem+json"; then
  ok 1 "puppet:false rejected 400 problem+json"
else
  bad 1 "code=$CODE ct=$CT"
fi

# 2. Default is puppet: session config logs create_response:false
: > "$HERE/logs/session-config.log"
curl -s -X POST http://localhost:8787/token -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' -d '{}' > /dev/null
if grep -q '"create_response":false' "$HERE/logs/session-config.log"; then
  ok 2 "default session is puppet (create_response:false) [MS3]"
else
  bad 2 "default session did not log create_response:false"
fi

# 3. Silence regression: 🗣️(synthetic) speech still yields zero self-responses
bash "$HERE/tests/rig/make-wav.sh" /tmp/m2t4.wav "Hello, are you there?" >/dev/null
if node "$HERE/tests/rig/driver.mjs" --wav /tmp/m2t4.wav --puppet 1 --noroute 1 --watch 14 --out /tmp/m2t4.json; then
  CREATED=$(jq '[.events[]|select(.type=="response.created")]|length' /tmp/m2t4.json)
  STOPPED=$(jq '[.events[]|select(.type=="input_audio_buffer.speech_stopped")]|length' /tmp/m2t4.json)
  # Routed replies are allowed (that IS the product); what must never happen is
  # a response the SERVER did not ask for. The turn router is disabled for this
  # probe via ?noroute=1 so any response.created would be self-generated.
  if [ "$STOPPED" -ge 1 ] && [ "$CREATED" -eq 0 ]; then
    ok 3 "speech detected, zero self-generated responses"
  else
    bad 3 "speech_stopped=$STOPPED response.created=$CREATED"
  fi
else
  bad 3 "rig run failed"
fi

exit $FAIL
