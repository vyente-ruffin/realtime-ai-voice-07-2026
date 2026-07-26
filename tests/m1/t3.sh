#!/bin/bash
# M1.T3 — Ears to the server: user-turn capture [MS4]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
RIG="$HERE/tests/rig"
TURNS="$HERE/logs/turns.log"
FAIL=0
ok()  { echo "  PASS m1.t3.$1: $2"; }
bad() { echo "  FAIL m1.t3.$1: $2"; FAIL=1; }

: > "$TURNS" 2>/dev/null || true

# 1. 🗣️(synthetic) one sentence → /turn entry with transcript within 3s of speech_stopped
bash "$RIG/make-wav.sh" /tmp/m1t3a.wav "The microphone pipeline works." >/dev/null
if node "$RIG/driver.mjs" --wav /tmp/m1t3a.wav --puppet 1 --watch 10 --out /tmp/m1t3a.json; then
  STOP_TS=$(jq -r '[.events[]|select(.type=="input_audio_buffer.speech_stopped")][0].ts // empty' /tmp/m1t3a.json)
  TURN_LINE=$(grep -m1 "microphone" "$TURNS" 2>/dev/null || true)
  TURN_TS=$(echo "$TURN_LINE" | jq -r '.receivedAt // empty' 2>/dev/null)
  if [ -n "$STOP_TS" ] && [ -n "$TURN_TS" ] && [ $((TURN_TS - STOP_TS)) -le 3000 ] && [ $((TURN_TS - STOP_TS)) -ge -500 ]; then
    ok 1 "turn captured $((TURN_TS - STOP_TS))ms after speech_stopped"
  else
    bad 1 "no timely /turn entry (stop=$STOP_TS turn=$TURN_TS)"
  fi
else
  bad 1 "rig run failed"
fi

# 2. 🗣️(synthetic) three sentences → three turns, content order preserved
: > "$TURNS"
bash "$RIG/make-wav.sh" /tmp/m1t3b.wav "Turn one." "Turn two." "Turn three." >/dev/null
if node "$RIG/driver.mjs" --wav /tmp/m1t3b.wav --puppet 1 --watch 18 --out /tmp/m1t3b.json; then
  ORDER=$(grep -oiE "turn (one|two|three)" "$TURNS" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')
  if echo "$ORDER" | grep -q "turn one .*turn two .*turn three"; then
    ok 2 "three turns in spoken order: $ORDER"
  else
    bad 2 "order wrong or incomplete: '$ORDER'"
  fi
else
  bad 2 "rig run failed"
fi

# 3. Transcription config guarded: non-empty transcripts, no failures, model form logged
FAILED=$(jq '[.events[]|select(.type=="conversation.item.input_audio_transcription.failed")]|length' /tmp/m1t3b.json 2>/dev/null || echo 1)
if [ "$FAILED" = "0" ] && grep -q '"transcriptionModel"' "$HERE/logs/session-config.log" 2>/dev/null && [ -s "$TURNS" ]; then
  ok 3 "no transcription failures; model form logged ([MS4-note]; whisper-1 [LIVE-5])"
else
  bad 3 "transcription failures=$FAILED or model form not logged"
fi

exit $FAIL
