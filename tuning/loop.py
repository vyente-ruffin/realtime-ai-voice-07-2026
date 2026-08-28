#!/usr/bin/env python3
"""Drive the full autoresearch loop unattended.

Implements the loop from the `autoresearch-loop` skill: one change per run,
restart + verify, benchmark, keep-or-revert on the metric, log every row.
Runs to the end of the budget without pausing - the whole point is that the
human gets a table, not a series of interruptions.

Each experiment cites its source (see PROGRAM.md "Idea sources").
"""

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TUNING = REPO / "tuning"
HS = Path("/home/localadmin/.hermes/profiles/voice/hindsight/config.json")

C7 = "context7 /vectorize-io/hindsight"
MSL = "MS Learn realtime-audio"

# (run_id, config patch, one-line change, source)
# Ordered cheapest-hypothesis-first so an early win narrows the later space.
EXPERIMENTS = [
    ("r01", {"recall_budget": "low", "recall_max_tokens": 2048},
     "budget high->low, tokens 4096->2048 (vendor voice preset)",
     f"{C7} pipecat voice guide 2026-07-17: recall_budget=low, recall_max_tokens=2048"),

    ("r02", {"recall_budget": "mid", "recall_max_tokens": 2048},
     "budget mid (isolate budget from token cap)",
     f"{C7} best-practices: mid is the default for general reasoning"),

    ("r03", {"recall_budget": "low", "recall_max_tokens": 1024},
     "tokens 2048->1024 at low budget",
     f"{C7} 'cap injected context so TTS starts fast' - probe the floor"),

    ("r04", {"recall_budget": "low", "recall_max_tokens": 2048,
             "recall_types": "observation,world"},
     "drop 'experience' from recall_types",
     "r01 measurement + Hindsight type model: observations are consolidated, "
     "experiences are raw episodes"),

    ("r05", {"recall_budget": "low", "recall_max_tokens": 2048,
             "recall_types": "observation"},
     "observations only",
     "r04 result - observations are the distilled layer"),

    ("r06", {"recall_budget": "low", "recall_max_tokens": 2048,
             "recall_types": "observation,world,experience",
             "memory_mode": "prefetch"},
     "memory_mode hybrid->prefetch",
     f"{C7} memory_mode: hybrid runs prefetch AND leaves tools armed"),

    ("r07", {"recall_budget": "low", "recall_max_tokens": 2048,
             "memory_mode": "hybrid", "auto_recall": False},
     "auto_recall off (tools-only recall)",
     "PROGRAM.md Q5 - a filler turn should not pay a full search"),

    ("r08", {"recall_budget": "low", "recall_max_tokens": 3072,
             "auto_recall": True, "recall_types": "observation,world,experience"},
     "tokens 2048->3072 at low budget",
     "bracket the token cap between the r01 and r03 results"),
]


def read_cfg() -> dict:
    return json.loads(HS.read_text())


def write_cfg(cfg: dict) -> None:
    HS.write_text(json.dumps(cfg, indent=2))


def main() -> None:
    # r00 already recorded. Best-so-far is the baseline.
    best_ms = int(sys.argv[1])
    best_cfg = read_cfg()
    print(f"starting best: {best_ms} ms")

    for run_id, patch, change, source in EXPERIMENTS:
        # Always patch relative to the current BEST, never to the last run -
        # otherwise a discarded experiment silently contaminates the next one.
        write_cfg(best_cfg)

        proc = subprocess.run(
            [sys.executable, str(TUNING / "runner.py"), run_id,
             json.dumps(patch), change, source],
            capture_output=True, text=True, timeout=2400, cwd=REPO,
        )
        tail = proc.stdout.strip().splitlines()[-40:]
        blob = "\n".join(tail)
        try:
            result = json.loads(blob[blob.index("{"):])
        except (ValueError, json.JSONDecodeError):
            print(f"[{run_id}] UNPARSEABLE:\n{proc.stdout[-800:]}\n{proc.stderr[-400:]}")
            write_cfg(best_cfg)
            continue

        ms, ok = result["median_ms"], result["guards_ok"]
        improved = ok and ms < best_ms
        print(f"[{run_id}] {ms} ms  guards={ok}  -> "
              f"{'KEEP' if improved else 'discard'}  ({change})")

        if improved:
            best_ms, best_cfg = ms, read_cfg()
        else:
            write_cfg(best_cfg)  # revert immediately, before the next idea

    write_cfg(best_cfg)
    print(f"\nFINAL best: {best_ms} ms")
    print(json.dumps({k: best_cfg.get(k) for k in
                      ("recall_budget", "recall_max_tokens", "recall_types",
                       "memory_mode", "auto_recall")}, indent=2))


if __name__ == "__main__":
    main()
