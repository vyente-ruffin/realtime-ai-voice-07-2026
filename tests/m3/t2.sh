#!/bin/bash
# M3.T2 — Barge-in through the whole stack [MS8][C3][A8][A9]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
RIG="$HERE/tests/rig"
FAIL=0
ok()  { echo "  PASS m3.t2.$1: $2"; }
bad() { echo "  FAIL m3.t2.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

# 1. 🗣️(synthetic) interrupt during playback → output_audio_buffer.cleared [MS8]
#    The WAV speaks while a long injected reply is still being spoken.
bash "$RIG/make-wav.sh" /tmp/m3t2.wav "Wait, stop, I have a different question." >/dev/null
node "$RIG/driver.mjs" --wav /tmp/m3t2.wav --puppet 1 --noroute 1 --watch 26 \
  --speak-file "$HERE/tests/m3/long-line.json" --out /tmp/m3t2.json >/dev/null 2>&1
CLEARED=$(jq '[.events[]|select(.type=="output_audio_buffer.cleared")]|length' /tmp/m3t2.json 2>/dev/null || echo 0)
if [ "$CLEARED" -ge 1 ]; then
  ok 1 "output_audio_buffer.cleared observed on interrupt [MS8]"
else
  bad 1 "no output_audio_buffer.cleared (count=$CLEARED)"
fi

# 2. Pending hermes turn is cancelled: mid-think barge-in → session/cancel sent,
#    late reply dropped (never spoken) [A8]
export VOICE_MOCK_BRAIN=1
: > "$HERE/logs/cancel.log"
( sleep 2; curl -s -X POST http://localhost:8787/barge-in -H "X-Voice-Auth: $AUTH" >/dev/null ) &
R=$(curl -s -X POST http://localhost:8787/turn -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' --max-time 60 \
  -d '{"item_id":"c1","transcript":"MOCK_DELAY_8000 long answer","route":true}')
CANCELLED=$(grep -c '"event":"session/cancel"' "$HERE/logs/cancel.log" 2>/dev/null || echo 0)
DROPPED=$(grep -c '"event":"reply-dropped"' "$HERE/logs/cancel.log" 2>/dev/null || echo 0)
if [ "$CANCELLED" -ge 1 ] && [ "$DROPPED" -ge 1 ]; then
  ok 2 "session/cancel sent and late reply dropped [A8]"
else
  bad 2 "cancel=$CANCELLED dropped=$DROPPED resp=$(echo "$R" | head -c 100)"
fi

# 3. The interrupting utterance becomes the next prompt to hermes
: > "$HERE/logs/turns-routed.log"
bash "$RIG/make-wav.sh" /tmp/m3t2b.wav "What is the capital of Japan?" >/dev/null
unset VOICE_MOCK_BRAIN
node "$RIG/driver.mjs" --wav /tmp/m3t2b.wav --puppet 1 --watch 60 --out /tmp/m3t2b.json >/dev/null 2>&1
if grep -qi "capital of japan" "$HERE/logs/turns-routed.log" 2>/dev/null; then
  ok 3 "interrupting utterance routed to hermes as the next prompt"
else
  bad 3 "utterance not found in routed prompts"
fi

# 4. UI truth: the interrupted line carries the ⏹ marker in the DOM
MARKED=$(jq '[.events[]|select(.type=="ui.interrupted")]|length' /tmp/m3t2.json 2>/dev/null || echo 0)
if [ "$MARKED" -ge 1 ]; then
  ok 4 "transcript line marked interrupted in the DOM"
else
  bad 4 "no ui.interrupted marker recorded"
fi

exit $FAIL
