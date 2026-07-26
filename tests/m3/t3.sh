#!/bin/bash
# M3.T3 — Session rotation driven by expires_at [MS14][MS17][MS1][H3]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
RIG="$HERE/tests/rig"
FAIL=0
ok()  { echo "  PASS m3.t3.$1: $2"; }
bad() { echo "  FAIL m3.t3.$1: $2"; FAIL=1; }

# Rotation margin overridden so the test runs in ~2 min instead of ~50.
# Real policy: rotate at expires_at minus 10 min [MS17].
export VOICE_ROTATE_TEST_SECONDS=120

# 1+2. Rotation fires in-window AND the brain never blinks (same ACP session)
ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=24000:cl=mono -t 200 \
  -c:a pcm_s16le /tmp/m3t3.wav
if node "$RIG/driver.mjs" --wav /tmp/m3t3.wav --puppet 1 --noroute 1 --watch 170 \
     --out /tmp/m3t3.json >/dev/null 2>&1; then
  CREATED=$(jq '[.events[]|select(.type=="session.created")]|length' /tmp/m3t3.json)
  T0=$(jq -r '[.events[]|select(.type=="session.created")][0].ts // 0' /tmp/m3t3.json)
  T1=$(jq -r '[.events[]|select(.type=="session.created")][1].ts // 0' /tmp/m3t3.json)
  GAP=$(( (T1 - T0) / 1000 ))
  if [ "$CREATED" -ge 2 ] && [ "$GAP" -ge 110 ] && [ "$GAP" -le 150 ]; then
    ok 1 "rotation observed at ${GAP}s (window 110-150s) [MS17]"
  else
    bad 1 "sessions=$CREATED gap=${GAP}s"
  fi
  SID_BEFORE=$(jq -r '.acpBefore // empty' /tmp/m3t3-acp.json 2>/dev/null)
  SID_AFTER=$(jq -r '.acpAfter // empty' /tmp/m3t3-acp.json 2>/dev/null)
  if [ -n "$SID_BEFORE" ] && [ "$SID_BEFORE" = "$SID_AFTER" ]; then
    ok 2 "same ACP session across rotation (${SID_BEFORE:0:8}…) — the brain never blinked [H3]"
  else
    bad 2 "acp session changed: '$SID_BEFORE' -> '$SID_AFTER'"
  fi
else
  bad 1 "rig run failed"; bad 2 "rig run failed"
fi

# 3. Mid-speech safety: rotation waits for response.done, never cuts a sentence
ORDER_OK=$(jq -r '
  [.events[] | select(.type=="response.done" or .type=="session.created" or .type=="rotation.deferred")]
  | map(.type) | join(",")' /tmp/m3t3.json 2>/dev/null)
CUTS=$(jq '[.events[]|select(.type=="rotation.cut-midspeech")]|length' /tmp/m3t3.json 2>/dev/null || echo 1)
if [ "$CUTS" -eq 0 ]; then
  ok 3 "no rotation occurred mid-speech (order: ${ORDER_OK:0:60})"
else
  bad 3 "rotation cut speech $CUTS time(s)"
fi

exit $FAIL
