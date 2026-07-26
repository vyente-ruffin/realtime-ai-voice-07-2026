#!/bin/bash
# M1.T1 — Silence the brain: create_response:false [MS3][C2]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
RIG="$HERE/tests/rig"
FAIL=0
ok()  { echo "  PASS m1.t1.$1: $2"; }
bad() { echo "  FAIL m1.t1.$1: $2"; FAIL=1; }

# 1. Puppet flag accepted and applied (echo + logged session-config payload)
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"
R="$(curl -s -X POST http://localhost:8787/token -H "X-Voice-Auth: $AUTH" -H 'Content-Type: application/json' -d '{"puppet":true}')"
if echo "$R" | jq -e '.settings.puppet == true' >/dev/null 2>&1 && \
   grep -q '"create_response":false' "$HERE/logs/session-config.log" 2>/dev/null; then
  ok 1 "puppet flag echoed and create_response:false logged"
else
  bad 1 "puppet flag not applied (echo or session-config.log)"
fi

# 2+3. 🗣️(synthetic) puppet session: speech in → NO response.created, but
#      transcription arrives [MS3][MS4][MS15]. LIVE-12 proof ride-along.
bash "$RIG/make-wav.sh" /tmp/m1t1.wav "Hello puppet, can you hear me?" >/dev/null
if node "$RIG/driver.mjs" --wav /tmp/m1t1.wav --puppet 1 --watch 12 --out /tmp/m1t1.json; then
  STOPPED=$(jq '[.events[]|select(.type=="input_audio_buffer.speech_stopped")]|length' /tmp/m1t1.json)
  CREATED=$(jq '[.events[]|select(.type=="response.created")]|length' /tmp/m1t1.json)
  TRANSCRIBED=$(jq -r '[.events[]|select(.type=="conversation.item.input_audio_transcription.completed" and (.transcript|length>0))]|length' /tmp/m1t1.json)
  if [ "$STOPPED" -ge 1 ] && [ "$CREATED" -eq 0 ]; then
    ok 2 "speech_stopped=$STOPPED, response.created=0 — the mouth stayed shut (LIVE-12 proven)"
  else
    bad 2 "speech_stopped=$STOPPED response.created=$CREATED (puppet self-responded or VAD dead)"
  fi
  if [ "$TRANSCRIBED" -ge 1 ]; then
    ok 3 "input transcription arrived non-empty"
  else
    bad 3 "no non-empty transcription.completed"
  fi
else
  bad 2 "rig run failed"; bad 3 "rig run failed"
fi

# 4. RETIRED at M2. This asserted that classic mode (the model answering with
# its own brain) still worked — a dev-only A/B scaffold the plan scoped to M1
# alone ("removed at M2 gate"). M2.T4 retires it for real: /token refuses
# puppet:false, so the old assertion contradicts shipped behavior. Successor:
# m2.t4.1 (classic mode REFUSED). m1.t1 retains 3 binary tests.

exit $FAIL
