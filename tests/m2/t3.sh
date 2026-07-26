#!/bin/bash
# M2.T3 — Memory continuity proof, BOTH directions (the north-star test)
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
ok()  { echo "  PASS m2.t3.$1: $2"; }
bad() { echo "  FAIL m2.t3.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

route() {  # route() "<transcript>" -> prints the spoken reply
  curl -s -X POST http://localhost:8787/turn -H "X-Voice-Auth: $AUTH" \
    -H 'Content-Type: application/json' --max-time 240 \
    -d "{\"item_id\":\"mem-$RANDOM\",\"transcript\":$(jq -Rn --arg t "$1" '$t'),\"route\":true}" \
    | jq -r '.spoken // ""'
}

# 1. READ direction: memory seeded OUTSIDE voice must surface INSIDE voice.
hermes -z "Remember this for later: the red walrus code is 3389." >/dev/null 2>&1
R1=$(route "What is the red walrus code? Answer with just the number.")
if echo "$R1" | grep -q "3389"; then
  ok 1 "pre-seeded memory surfaced in a voice turn: $(echo "$R1" | head -c 60)"
else
  bad 1 "red walrus code not recalled: $(echo "$R1" | head -c 120)"
fi

# 2. In-session recall across turns
route "Please remember: the blue kangaroo code is 7141." >/dev/null
route "Thanks. What is two plus two?" >/dev/null
route "What day comes after Monday?" >/dev/null
R2=$(route "What is the blue kangaroo code? Answer with just the number.")
if echo "$R2" | grep -q "7141"; then
  ok 2 "in-session recall after 3 intervening turns"
else
  bad 2 "blue kangaroo code lost: $(echo "$R2" | head -c 120)"
fi

# 3. WRITE direction: what was said by voice is visible from another front-end
R3=$(hermes -z "What is the blue kangaroo code that was mentioned earlier? Answer with just the number." 2>/dev/null)
if echo "$R3" | grep -q "7141"; then
  ok 3 "voice conversation persisted to hermes memory (CLI front-end sees it)"
else
  bad 3 "not visible from CLI: $(echo "$R3" | tail -c 160)"
fi

# 4. Session visible to hermes with its ACP session_id [H3]
SID=$(jq -r '.acpSessionId // empty' "$HERE/logs/acp-session.json" 2>/dev/null)
if [ -n "$SID" ] && hermes sessions 2>/dev/null | grep -q "${SID:0:8}"; then
  ok 4 "hermes sessions lists the voice session ${SID:0:8}…"
else
  bad 4 "voice ACP session id not found in hermes sessions (sid=${SID:-none})"
fi

exit $FAIL
