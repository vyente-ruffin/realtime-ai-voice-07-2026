#!/bin/bash
# Standing invariant gates INV-1..3 (plan Section 2) — prove the hermes install is undisturbed.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
B="$HERE/tests/baseline"
FAIL=0
REAL_HOME="${HERMES_REAL_HOME:-$HOME}"
HERMES_ROOT="${HERMES_ROOT:-$REAL_HOME/.hermes}"
EXPECTED_CONFIG_SHA="${VOICE_INV_CONFIG_SHA_BEFORE:-$(<"$B/config.sha")}"
EXPECTED_GATEWAY_SHA="${VOICE_INV_GATEWAY_SHA_BEFORE:-$(shasum -a 256 "$B/gateway.txt" | cut -d ' ' -f 1)}"
EXPECTED_DOCTOR_EXIT="${VOICE_INV_DOCTOR_EXIT_BEFORE:-$(<"$B/doctor.exit")}"

# INV-1: config.yaml byte-identical to the pre-run snapshot (or frozen baseline).
CURRENT_CONFIG_SHA="$(shasum -a 256 "$HERMES_ROOT/config.yaml" | cut -d ' ' -f 1)"
if [ "$CURRENT_CONFIG_SHA" = "$EXPECTED_CONFIG_SHA" ]; then
  echo "  PASS INV-1: config.yaml checksum unchanged"
else
  echo "  FAIL INV-1: config.yaml checksum differs from baseline"; FAIL=1
fi

# INV-2: hermes doctor exit code equals baseline
HERMES_HOME="$HERMES_ROOT" hermes doctor >/dev/null 2>&1
NOW=$?
if [ "$NOW" = "$EXPECTED_DOCTOR_EXIT" ]; then
  echo "  PASS INV-2: doctor exit unchanged ($NOW)"
else
  echo "  FAIL INV-2: doctor exit $NOW != pre-run $EXPECTED_DOCTOR_EXIT"; FAIL=1
fi

# INV-3: gateway platform list unchanged (normalized and hashed).
CURRENT_GATEWAY_SHA="$(HERMES_HOME="$HERMES_ROOT" hermes gateway list 2>/dev/null | sort | shasum -a 256 | cut -d ' ' -f 1)"
if [ "$CURRENT_GATEWAY_SHA" = "$EXPECTED_GATEWAY_SHA" ]; then
  echo "  PASS INV-3: gateway platform list unchanged"
else
  echo "  FAIL INV-3: gateway platform list differs from baseline"; FAIL=1
fi

exit $FAIL
