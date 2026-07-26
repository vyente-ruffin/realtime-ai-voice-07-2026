#!/bin/bash
# M2.T1 — ACP client in talk-server [A5][A2][A6][H3][A9]
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
ok()  { echo "  PASS m2.t1.$1: $2"; }
bad() { echo "  FAIL m2.t1.$1: $2"; FAIL=1; }

BEFORE=$(pgrep -f "hermes acp" | wc -l | tr -d ' ')

# 1-3 + 5 are exercised by the node test (handshake, isolation, no orphans,
# permission policy); it prints its own PASS/FAIL lines and exits nonzero on
# any failure.
if node "$HERE/tests/m2/t1.test.mjs"; then
  :
else
  FAIL=1
fi

# 4. Config untouched after a 5-cycle spawn/kill loop (INV-1 immediately)
if bash "$HERE/scripts/inv.sh" 2>/dev/null | grep -q "PASS INV-1"; then
  ok 4 "config.yaml checksum unchanged after spawn/kill cycles"
else
  bad 4 "INV-1 failed right after ACP spawn/kill cycles"
fi

AFTER=$(pgrep -f "hermes acp" | wc -l | tr -d ' ')
echo "    (hermes acp processes: before=$BEFORE after=$AFTER)"

exit $FAIL
