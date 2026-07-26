#!/bin/bash
# M1.T2 — Say-exactly injection, adversarial corpus [MS6][C1][C5]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
RIG="$HERE/tests/rig"
CORPUS="$HERE/tests/m1/corpus.json"
FAIL=0
ok()  { echo "  PASS m1.t2.$1: $2"; }
bad() { echo "  FAIL m1.t2.$1: $2"; FAIL=1; }

# Silent WAV (no user speech): the session exists purely to be a mouth.
bash "$RIG/make-wav.sh" /tmp/m1t2-silence.wav "" >/dev/null 2>&1 || \
  ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=24000:cl=mono -t 3 -c:a pcm_s16le /tmp/m1t2-silence.wav

if ! node "$RIG/driver.mjs" --wav /tmp/m1t2-silence.wav --puppet 1 --watch 4 \
     --speak-file "$CORPUS" --out /tmp/m1t2.json; then
  bad 1 "rig run with speak-file failed"; exit 1
fi

N=$(jq 'length' "$CORPUS")

# 1. All six injections spoke (response.done with non-empty transcripts)
DONE=$(jq '[.events[]|select(.type=="response.done")]|length' /tmp/m1t2.json)
TRANSCRIPTS=$(jq '[.events[]|select(.type=="response.output_audio_transcript.done" and (.text|length>0))]|length' /tmp/m1t2.json)
if [ "$DONE" -ge "$N" ] && [ "$TRANSCRIPTS" -ge "$N" ]; then
  ok 1 "$DONE responses done, $TRANSCRIPTS non-empty transcripts"
else
  bad 1 "done=$DONE transcripts=$TRANSCRIPTS (want >= $N)"
fi

# 2+3. Verbatim fidelity >= 0.9 AND no embellishment (len <= 1.25x), EVERY item
ALLJ=1
for i in $(seq 0 $((N-1))); do
  EXPECTED=$(jq -r ".[$i]" "$CORPUS")
  ACTUAL=$(jq -r "[.events[]|select(.type==\"response.output_audio_transcript.done\")][$i].text // \"\"" /tmp/m1t2.json)
  SCORE=$(node "$RIG/jaccard.mjs" "$EXPECTED" "$ACTUAL") || ALLJ=0
  echo "    item $i: $SCORE"
done
[ $ALLJ -eq 1 ] && ok 2 "all $N items Jaccard >= 0.9" || bad 2 "fidelity below 0.9 on at least one item"
[ $ALLJ -eq 1 ] && ok 3 "all $N items length ratio <= 1.25" || bad 3 "embellishment detected"

# 4. Written to conversation (response items appended [C1])
ITEMS=$(jq '[.events[]|select(.type=="conversation.item.created" or .type=="conversation.item.added")]|length' /tmp/m1t2.json)
if [ "$ITEMS" -ge "$N" ]; then
  ok 4 "$ITEMS conversation items recorded"
else
  bad 4 "only $ITEMS conversation item events (want >= $N)"
fi

exit $FAIL
