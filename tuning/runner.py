#!/usr/bin/env python3
"""Apply a config, restart the voice server, verify it took, run the benchmark.

Enforces the autoresearch-loop restart discipline: Hermes and Hindsight read
config only at process start, so a run that measures without restarting is
measuring the PREVIOUS config and is void. This script refuses to benchmark
until it has seen the new value in the server's startup log.

Usage:
    python3 tuning/runner.py <run_id> '<json config patch>' '<change>' '<source>'

Example:
    python3 tuning/runner.py r01 '{"recall_budget":"low"}' \
        'recall_budget high->low' 'context7 /vectorize-io/hindsight voice guide'
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TUNING = REPO / "tuning"
CONFIGS = TUNING / "configs"
RESULTS = TUNING / "results.tsv"
HS_CONFIG = Path("/home/localadmin/.hermes/profiles/voice/hindsight/config.json")

SERVER_ENV = {
    "HOST": "0.0.0.0",
    "AZURE_CONFIG_DIR": "/home/localadmin/.azure",
    "AZURE_SUBSCRIPTION_ID": "e1e5b742-d76b-4ce5-97d3-8d820bb33904",
    "AZURE_OPENAI_ENDPOINT": "https://ai103-resource-ruffin.openai.azure.com",
    "AZURE_OPENAI_DEPLOYMENT_NAME": "gpt-realtime-2.1",
    "PATH": "/home/localadmin/.local/bin:" + os.environ.get("PATH", ""),
}


def stop_server() -> None:
    subprocess.run(["pkill", "-f", "node talk-server.js"], check=False)
    subprocess.run(["pkill", "-f", "hermes -p voice acp"], check=False)
    time.sleep(3)


def start_server(logfile: Path):
    env = {**os.environ, **SERVER_ENV}
    fh = logfile.open("w")
    return subprocess.Popen(["node", "talk-server.js"], cwd=REPO,
                            stdout=fh, stderr=subprocess.STDOUT, env=env)


def wait_ready(logfile: Path, expect: dict, timeout: int = 180) -> str:
    """Block until the brain is warm AND the log echoes the expected config.

    Returns the matched 'Hindsight initialized' line as proof of what is live.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if logfile.exists():
            text = logfile.read_text()
            m = re.search(r"Hindsight initialized: ([^\"\\\\]+)", text)
            if m and "Standby brain warm" in text:
                line = m.group(1)
                # budget= is the field the plugin logs; verify it matches the
                # patch we just applied, otherwise we would benchmark stale config.
                want = expect.get("recall_budget") or expect.get("budget")
                if want is None or f"budget={want}" in line:
                    return line
        time.sleep(3)
    raise TimeoutError("server did not report the expected config in time")


def apply_patch(patch: dict) -> dict:
    cfg = json.loads(HS_CONFIG.read_text())
    before = dict(cfg)
    cfg.update(patch)
    # Hermes reads 'budget'; the Hindsight client reads 'recall_budget'. Keep
    # them in lockstep so the two layers never disagree.
    if "recall_budget" in patch:
        cfg["budget"] = patch["recall_budget"]
    HS_CONFIG.write_text(json.dumps(cfg, indent=2))
    return before


def append_row(run: str, metric: int, guard: str, status: str,
               change: str, source: str) -> None:
    if not RESULTS.exists():
        RESULTS.write_text("run\tmetric\tguard\tstatus\tchange\tsource\n")
    with RESULTS.open("a") as fh:
        fh.write(f"{run}\t{metric}\t{guard}\t{status}\t{change}\t{source}\n")


def main() -> None:
    run_id, patch_json, change, source = sys.argv[1:5]
    patch = json.loads(patch_json)
    CONFIGS.mkdir(parents=True, exist_ok=True)

    apply_patch(patch)
    # Snapshot the config for the record, with credentials stripped: this repo
    # is public, and the live memory key lives in the same file.
    snapshot = json.loads(HS_CONFIG.read_text())
    for k in ("api_key", "apiKey", "apikey", "token", "secret", "password"):
        if snapshot.get(k):
            snapshot[k] = "REDACTED"
    CONFIGS.joinpath(f"{run_id}.json").write_text(json.dumps(snapshot, indent=2))

    stop_server()
    logfile = TUNING / f"server-{run_id}.log"
    start_server(logfile)
    live = wait_ready(logfile, patch)
    print(f"[{run_id}] live config: {live[:120]}")

    out = subprocess.run(
        [sys.executable, str(TUNING / "bench.py"), run_id, "3"],
        capture_output=True, text=True, timeout=1800,
    )
    result = json.loads(out.stdout)

    guard = "ok" if result["guards_ok"] else "FAIL:" + ",".join(
        k for k, v in result["guards"].items() if not v)
    status = "crash" if result["status"] == "crash" else (
        "pending" if result["guards_ok"] else "discard")
    append_row(run_id, result["median_ms"], guard, status, change, source)

    TUNING.joinpath(f"{run_id}-full.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in
                      ("run", "median_ms", "min_ms", "max_ms", "guards_ok",
                       "guards", "config")}, indent=2))


if __name__ == "__main__":
    main()
