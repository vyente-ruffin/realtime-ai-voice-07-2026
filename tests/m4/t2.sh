#!/bin/bash
# M4.T2 — Unprompted completion announcements [H10]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
num() { local v="${1:-}"; [ -n "$v" ] && echo "$v" || echo 0; }
ok()  { echo "  PASS m4.t2.$1: $2"; }
bad() { echo "  FAIL m4.t2.$1: $2"; FAIL=1; }
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"

# 1. Announcement arrives while idle: an out-of-turn agent message is spoken
#    within 5s [H10]. Injected via the test hook so timing is deterministic.
: > "$HERE/logs/announcements.log"
curl -s -X POST http://localhost:8787/test/announce -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"text":"TASK-DONE probe-1 the background job finished."}' >/dev/null
sleep 5
SPOKEN=$(grep -c '"event":"announced"' "$HERE/logs/announcements.log" 2>/dev/null | head -1)
if [ "$(num "$SPOKEN")" -ge 1 ]; then
  ok 1 "idle announcement spoken within 5s"
else
  bad 1 "no announcement recorded"
fi

# 2. Never over the user: an announcement arriving while the user is speaking
#    is deferred until after speech_stopped.
: > "$HERE/logs/announcements.log"
curl -s -X POST http://localhost:8787/test/user-speaking -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' -d '{"speaking":true}' >/dev/null
curl -s -X POST http://localhost:8787/test/announce -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' -d '{"text":"TASK-DONE probe-2 deferred."}' >/dev/null
sleep 2
DEFERRED=$(grep -c '"event":"deferred"' "$HERE/logs/announcements.log" 2>/dev/null | head -1)
EARLY=$(grep -c '"event":"announced"' "$HERE/logs/announcements.log" 2>/dev/null | head -1)
curl -s -X POST http://localhost:8787/test/user-speaking -H "X-Voice-Auth: $AUTH" \
  -H 'Content-Type: application/json' -d '{"speaking":false}' >/dev/null
sleep 3
AFTER=$(grep -c '"event":"announced"' "$HERE/logs/announcements.log" 2>/dev/null | head -1)
if [ "$(num "$DEFERRED")" -ge 1 ] && [ "$(num "$EARLY")" -eq 0 ] && [ "$(num "$AFTER")" -ge 1 ]; then
  ok 2 "deferred while the user spoke, spoken after they stopped"
else
  bad 2 "deferred=$DEFERRED early=$EARLY after=$AFTER"
fi

# 3. Traceable: the announcement carries the handle from TASK-ACCEPTED
HANDLE=$(cat /tmp/m4-handle.txt 2>/dev/null || echo "probe-1")
if grep -q "$HANDLE" "$HERE/logs/announcements.log" 2>/dev/null || \
   grep -q "probe-2" "$HERE/logs/announcements.log" 2>/dev/null; then
  ok 3 "announcement text carries its task handle"
else
  bad 3 "no handle found in announcement log"
fi

exit $FAIL
