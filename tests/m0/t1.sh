#!/bin/bash
# M0.T1 — Freeze invariants & verify the existing harness (plan: docs/VOICE-PLATFORM-PLAN.md)
# Binary: exits 0 only if all 7 checks pass.
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
B="$HERE/tests/baseline"
FAIL=0
ok()  { echo "  PASS m0.t1.$1: $2"; }
bad() { echo "  FAIL m0.t1.$1: $2"; FAIL=1; }

# 1. Baselines exist and are non-empty
if [ -s "$B/config.sha" ] && [ -s "$B/doctor.exit" ] && [ -s "$B/gateway.txt" ]; then
  ok 1 "baselines present"
else
  bad 1 "baseline files missing/empty (run scripts/freeze-baseline.sh)"
fi

# 2. Baseline is healthy: doctor exit 0 OR documented waiver [LIVE-7]
DOCEXIT="$(cat "$B/doctor.exit" 2>/dev/null || echo 999)"
if [ "$DOCEXIT" = "0" ] || [ -s "$B/doctor.waiver" ]; then
  ok 2 "doctor baseline healthy (exit=$DOCEXIT, waiver=$([ -s "$B/doctor.waiver" ] && echo yes || echo no))"
else
  bad 2 "hermes doctor baseline exit=$DOCEXIT and no waiver"
fi

# 3. Baseline determinism: gateway list (normalized) stable across 10s [LIVE-8]
G1="$(hermes gateway list 2>/dev/null | sort)"
sleep 10
G2="$(hermes gateway list 2>/dev/null | sort)"
if [ -n "$G1" ] && [ "$G1" = "$G2" ]; then
  ok 3 "gateway list deterministic (normalized)"
else
  bad 3 "gateway list non-deterministic or empty"
fi

# 4. hermes CLI surfaces answer [LIVE-9][LIVE-10][LIVE-11]
S_OK=1
hermes sessions >/dev/null 2>&1 || { S_OK=0; echo "    (hermes sessions failed)"; }
Z_OUT="$(hermes -z "Reply with exactly OK" 2>/dev/null)"
echo "$Z_OUT" | grep -qi "OK" || { S_OK=0; echo "    (hermes -z did not contain OK)"; }
hermes send --help >/dev/null 2>&1 || { S_OK=0; echo "    (hermes send --help failed)"; }
[ $S_OK -eq 1 ] && ok 4 "sessions / -z / send all answer" || bad 4 "a hermes CLI surface failed"

# 5. Token mint works [MS1] — talk-server must be running (gate.sh starts it)
AUTH="$(curl -s http://localhost:8787/ | sed -n 's/.*voice-auth" content="\([^"]*\)".*/\1/p')"
EPH="$(curl -s -X POST http://localhost:8787/token -H "X-Voice-Auth: $AUTH" | jq -r '.ephemeralKey // empty' 2>/dev/null)"
if [ -n "$EPH" ]; then
  ok 5 "ephemeral key minted (${EPH:0:6}…) [LIVE-6 expires_at recorded by gate.sh]"
else
  bad 5 "no ephemeralKey from /token"
fi

# 6. WS smoke test passes [LIVE-1]
( cd "$HERE" && node voice-test.js >/dev/null 2>&1 )
if [ $? -eq 0 ] && [ "$(stat -f%z "$HERE/output.wav" 2>/dev/null || echo 0)" -gt 100000 ]; then
  ok 6 "voice-test.js exit 0, output.wav > 100KB"
else
  bad 6 "WS smoke test failed"
fi

# 7. Deployment name confirmed [LIVE-2] (docs list lags; see plan Sources caveat)
if az cognitiveservices account deployment list \
    --subscription e1e5b742-d76b-4ce5-97d3-8d820bb33904 -g rg-ai103 -n ai103-resource-ruffin 2>/dev/null \
    | jq -e '.[]|select(.name=="gpt-realtime-2.1")' >/dev/null; then
  ok 7 "deployment gpt-realtime-2.1 exists"
else
  bad 7 "deployment gpt-realtime-2.1 not found"
fi

exit $FAIL
