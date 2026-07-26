#!/bin/bash
# M0.T3 — Realtime budget & constraints documented (plan: docs/VOICE-PLATFORM-PLAN.md)
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="$HERE/docs/BUDGET.md"
FAIL=0
ok()  { echo "  PASS m0.t3.$1: $2"; }
bad() { echo "  FAIL m0.t3.$1: $2"; FAIL=1; }

# 1. All 4 numbers present, independently ANDed [MS14][MS11][LIVE-4]
if grep -qE "60.min" "$DOC" 2>/dev/null && grep -qE "32,?000" "$DOC" && \
   grep -qE "4,?096" "$DOC" && grep -qE "10K TPM|10000" "$DOC"; then
  ok 1 "60-min, 32K, 4096, 10K TPM all present"
else
  bad 1 "one or more budget numbers missing from BUDGET.md"
fi

# 2. Numbers carry their citations
if grep -q "MS14" "$DOC" 2>/dev/null && grep -q "MS11" "$DOC"; then
  ok 2 "citations MS14 + MS11 present"
else
  bad 2 "citation tags missing"
fi

# 3. Capacity confirmed live [LIVE-4]
if az cognitiveservices account deployment list \
    --subscription e1e5b742-d76b-4ce5-97d3-8d820bb33904 -g rg-ai103 -n ai103-resource-ruffin 2>/dev/null \
    | jq -e '.[]|select(.name=="gpt-realtime-2.1").sku.capacity >= 10' >/dev/null; then
  ok 3 "capacity >= 10 (10K TPM)"
else
  bad 3 "capacity check failed"
fi

# 4. Session-minutes estimate is a computation (formula line with =)
if grep -E "minutes/session.*=" "$DOC" >/dev/null 2>&1; then
  ok 4 "formula line present"
else
  bad 4 "no minutes/session formula"
fi

exit $FAIL
