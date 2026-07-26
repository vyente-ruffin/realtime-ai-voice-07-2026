#!/bin/bash
# Cumulative milestone gate runner (plan Section 3): gate.sh N runs suites
# m0..mN in order, then INV-1..3. Prints GATE PASS / GATE FAIL. Exit 0 iff pass.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
N="${1:?usage: gate.sh <milestone-number>}"
FAIL=0

# Only one gate at a time: concurrent runs fight over port 8787 and over the
# deployment's concurrent-session limit [MS11], producing false failures.
LOCK="/tmp/voice-gate.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[gate] another gate run holds $LOCK — refusing to run concurrently"
  exit 2
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Live suites need Azure env (tenant quirk: mint by --subscription; see CLAUDE.md #1).
export AZURE_TOKEN="$(az account get-access-token --subscription e1e5b742-d76b-4ce5-97d3-8d820bb33904 --resource https://ai.azure.com --query accessToken -o tsv)"
export AZURE_OPENAI_ENDPOINT="https://ai103-resource-ruffin.openai.azure.com"
export AZURE_OPENAI_DEPLOYMENT_NAME="gpt-realtime-2.1"

# Always restart the talk server with a freshly minted token: a long-running
# server holds an expired Entra token (~1h TTL, see LIVE-6) and answers 502.
echo "[gate] restarting talk-server with fresh token…"
lsof -ti:8787 | xargs kill 2>/dev/null
sleep 1
nohup node "$HERE/talk-server.js" > /tmp/talk-server-gate.log 2>&1 &
sleep 3

for m in $(seq 0 "$N"); do
  DIR="$HERE/tests/m$m"
  [ -d "$DIR" ] || { echo "[gate] no suite m$m — FAIL (cumulative gates require it)"; FAIL=1; continue; }
  for t in "$DIR"/t*.sh; do
    [ -e "$t" ] || continue
    echo "[gate] running $(basename "$DIR")/$(basename "$t")"
    bash "$t" || FAIL=1
  done
done

echo "[gate] invariant gates INV-1..3"
bash "$HERE/scripts/inv.sh" || FAIL=1

if [ $FAIL -eq 0 ]; then
  echo "GATE PASS (m0..m$N + INV)"
else
  echo "GATE FAIL (m0..m$N)"
fi
exit $FAIL
