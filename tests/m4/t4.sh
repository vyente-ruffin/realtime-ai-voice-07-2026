#!/bin/bash
# M4.T4 — server-enforced long-turn handoff regression
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"

if node --test "$HERE/tests/m4/t4.test.mjs"; then
  echo "  PASS m4.t4: slow foreground work crosses to an observable background continuation"
  exit 0
fi

echo "  FAIL m4.t4: long-turn handoff regression"
exit 1
