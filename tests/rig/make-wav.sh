#!/bin/bash
# Synthetic voice rig — text → WAV (24kHz mono PCM16) for Chromium's fake mic.
# Usage: make-wav.sh out.wav "sentence one" ["sentence two" ...]
# Sentences are separated by 1.2s silence (lets server VAD close each turn,
# silence_duration_ms default 500 [MS3 context]); 2.5s tail silence ends the
# final turn. Output format matches the session's 24kHz PCM16 input.
set -euo pipefail
OUT="$1"; shift
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

LIST="$TMP/list.txt"
: > "$LIST"

ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=24000:cl=mono -t 1.2 \
  -c:a pcm_s16le "$TMP/gap.wav"
ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=24000:cl=mono -t 2.5 \
  -c:a pcm_s16le "$TMP/tail.wav"
# 8s lead-in silence: the fake mic begins feeding audio at getUserMedia time,
# but the realtime session only receives after SDP negotiation completes
# (~4-6s observed). Evidence: with 0.8s, "Turn one." arrived as "Fun.".
ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=24000:cl=mono -t 8 \
  -c:a pcm_s16le "$TMP/lead.wav"
echo "file '$TMP/lead.wav'" >> "$LIST"

i=0
for TEXT in "$@"; do
  i=$((i+1))
  say -o "$TMP/seg$i.aiff" "$TEXT"
  ffmpeg -y -loglevel error -i "$TMP/seg$i.aiff" -ar 24000 -ac 1 \
    -c:a pcm_s16le "$TMP/seg$i.wav"
  echo "file '$TMP/seg$i.wav'" >> "$LIST"
  if [ $i -lt $# ]; then echo "file '$TMP/gap.wav'" >> "$LIST"; fi
done
echo "file '$TMP/tail.wav'" >> "$LIST"

ffmpeg -y -loglevel error -f concat -safe 0 -i "$LIST" -c copy "$OUT"
echo "wrote $OUT ($(stat -f%z "$OUT") bytes, $# sentence(s))"
