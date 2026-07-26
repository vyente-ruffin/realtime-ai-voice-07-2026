#!/bin/bash
# Standing invariant gates INV-1..3 (plan Section 2) — prove the hermes install is undisturbed.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
B="$HERE/tests/baseline"
FAIL=0

# INV-1: config.yaml byte-identical to baseline
if shasum -a 256 "$HOME/.hermes/config.yaml" | awk '{print $1}' | diff -q - "$B/config.sha" >/dev/null 2>&1; then
  echo "  PASS INV-1: config.yaml checksum unchanged"
else
  echo "  FAIL INV-1: config.yaml checksum differs from baseline"; FAIL=1
fi

# INV-2: hermes doctor exit code equals baseline
hermes doctor >/dev/null 2>&1
NOW=$?
BASE="$(cat "$B/doctor.exit" 2>/dev/null || echo 999)"
if [ "$NOW" = "$BASE" ]; then
  echo "  PASS INV-2: doctor exit unchanged ($NOW)"
else
  echo "  FAIL INV-2: doctor exit $NOW != baseline $BASE"; FAIL=1
fi

# INV-3: gateway platform list unchanged (normalized)
if hermes gateway list 2>/dev/null | sort | diff -q - "$B/gateway.txt" >/dev/null 2>&1; then
  echo "  PASS INV-3: gateway platform list unchanged"
else
  echo "  FAIL INV-3: gateway platform list differs from baseline"; FAIL=1
fi

exit $FAIL
