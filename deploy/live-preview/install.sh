#!/usr/bin/env bash
# Installs the already-built private preview. Does not replace production.
set -euo pipefail
umask 077

mode=${1:---check}
case "$mode" in
  --check|--install) ;;
  *) echo 'Usage: install.sh [--check|--install]' >&2; exit 2 ;;
esac

app_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
profile=voice-live-preview
profile_dir="$HOME/.hermes/profiles/$profile"
source_memory="$HOME/.hermes/profiles/voice/hindsight/config.json"
unit_dir="$HOME/.config/systemd/user"
preview_url=https://hermesubuntuv1.tailddc886.ts.net:8443/

for executable in node hermes python3 systemctl tailscale curl; do
  command -v "$executable" >/dev/null || { echo "Missing command: $executable" >&2; exit 1; }
done
[[ -r "$source_memory" && -f "$app_root/deploy/live-preview/voice-live-preview.service" ]]
[[ $(node -p 'Number(process.versions.node.split(".")[0]) >= 26') == true ]]
python3 - "$app_root" <<'PY_CHECK'
from pathlib import Path
import sys
root=Path(sys.argv[1])
unit=(root/'deploy/live-preview/voice-live-preview.service').read_text()
assert f'WorkingDirectory={root}\n' in unit, 'Service must point to this checkout.'
assert 'Environment=VOICE_QUALIFICATION=0\n' in unit
assert 'Environment=HOST=127.0.0.1\n' in unit
assert 'Environment=PORT=8789\n' in unit
PY_CHECK
if [[ "$mode" == --check ]]; then
  echo "Build setup is ready: $preview_url"
  echo 'Check only: no profiles, memories, services or routes changed.'
  exit 0
fi

# --install is the personal-memory/network action recorded in the preview README.
# Run it only after that exact destination and memory access are authorized.
if systemctl --user is-active --quiet voice-live-qualification.service ||
   systemctl --user is-active --quiet voice-live-preview.service; then
  echo 'Stop the active isolated voice service before installing.' >&2
  exit 1
fi
release="$HOME/.local/state/jarvis-voice/install-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$release" "$unit_dir"
tailscale serve status --json > "$release/serve.before.json"
tailscale status --json > "$release/tailscale.before.json"
systemctl --user cat voice-frontend.service > "$release/production.service.before"
python3 - "$release" "$source_memory" <<'PY_VALIDATE'
from pathlib import Path
import json, sys
root=Path(sys.argv[1]); serve=json.loads((root/'serve.before.json').read_text())
status=json.loads((root/'tailscale.before.json').read_text())
assert status['Self']['DNSName'].rstrip('.') == 'hermesubuntuv1.tailddc886.ts.net'
assert status.get('BackendState') == 'Running'
assert not any(serve.get('AllowFunnel',{}).values()), 'A private Tailscale route is required.'
assert not serve.get('TCP',{}).get('8443'), 'The preview port is already configured.'
handlers=serve['Web']['hermesubuntuv1.tailddc886.ts.net:443']['Handlers']
assert handlers['/']['Proxy'] == 'http://127.0.0.1:8787'
assert handlers['/docs']['Proxy'] == 'http://127.0.0.1:8790'
memory=json.loads(Path(sys.argv[2]).read_text())
assert (memory.get('bank_id') or memory.get('bankId')) == 'hermes', 'Personal setup requires the existing personal bank.'
PY_VALIDATE
sha256sum "$HOME/.hermes/profiles/voice/config.yaml" "$source_memory" > "$release/original-config.sha256"
if [[ ! -f "$profile_dir/config.yaml" ]]; then
  hermes profile create "$profile" --clone-from voice --no-alias
fi
cp "$profile_dir/config.yaml" "$release/worker-config.before.yaml"
hermes --profile "$profile" config set agent.environment_hint 'You are the background worker for Jarvis voice. The separate live voice model handles the conversation. Finish delegated work and return verified results. For missing personal facts, use hindsight_recall before saying they are unknown. If another tool is needed, use delegate_task synchronously (async=false) and wait for its result. Do not return a task receipt as a completed result. Preserve normal action permissions. Do not send messages to people unless the user explicitly requested it. Never change Hermes or Hindsight source code or installed versions.'
mkdir -p "$profile_dir/hindsight"
install -m 600 "$source_memory" "$profile_dir/hindsight/config.json"
HINDSIGHT_CONFIG_PATH="$profile_dir/hindsight/config.json" node "$app_root/scripts/prepare-voice-memory.mjs"
sha256sum --check --status "$release/original-config.sha256"
install -m 600 "$app_root/deploy/live-preview/voice-live-preview.service" "$unit_dir/voice-live-preview.service"
systemctl --user daemon-reload
# Stop a partially installed preview if readiness or route verification fails.
route_added=0
cleanup() {
  if [[ "$route_added" == 1 ]]; then tailscale serve --https=8443 off >/dev/null || true; fi
  systemctl --user stop voice-live-preview.service || true
}
trap cleanup ERR
systemctl --user start voice-live-preview.service
for attempt in {1..30}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8789/healthz > "$release/health.json" &&
     python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(not(d["status"]=="ready" and d["workerReady"] and not d["memoryWarning"]))' "$release/health.json"; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then echo 'Preview did not become ready.' >&2; false; fi
  sleep 1
done
route_added=1
tailscale serve --bg --https=8443 http://127.0.0.1:8789
tailscale serve status --json > "$release/serve.after.json"
python3 - "$release" <<'PY_VERIFY'
from pathlib import Path
import json, sys
root=Path(sys.argv[1]); before=json.loads((root/'serve.before.json').read_text()); after=json.loads((root/'serve.after.json').read_text())
for kind in ['TCP','Web']:
 for key,value in before.get(kind,{}).items():
  assert after[kind][key] == value, 'An existing route changed.'
assert not any(after.get('AllowFunnel',{}).values())
assert after['Web']['hermesubuntuv1.tailddc886.ts.net:8443']['Handlers']['/']['Proxy'] == 'http://127.0.0.1:8789'
PY_VERIFY
curl --fail --silent --max-time 10 "${preview_url}healthz" > "$release/https-health.json"
sha256sum --check --status "$release/original-config.sha256"
trap - ERR
echo "Private preview ready: $preview_url"
echo "Installation record: $release"
