#!/bin/bash
# M0.T1 — freeze the zero-disturbance baselines (plan Section 2 + M0.T1).
# Run ONCE at M0; INV-1..3 diff against these forever after.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
B="$HERE/tests/baseline"
mkdir -p "$B"

echo "Freezing config checksum (INV-1 anchor)…"
shasum -a 256 "$HOME/.hermes/config.yaml" | awk '{print $1}' > "$B/config.sha"

echo "Recording hermes doctor exit code (INV-2 anchor)…"
hermes doctor > "$B/doctor.out" 2>&1
echo $? > "$B/doctor.exit"
echo "  doctor exit: $(cat "$B/doctor.exit")"

echo "Freezing normalized gateway platform list (INV-3 anchor)…"
hermes gateway list 2>/dev/null | sort > "$B/gateway.txt"
wc -l < "$B/gateway.txt" | xargs echo "  gateway lines:"

echo "Baseline frozen at $(date -u +%FT%TZ)" > "$B/FROZEN"
echo "Done. Baselines in $B (gitignored, machine-local)."
