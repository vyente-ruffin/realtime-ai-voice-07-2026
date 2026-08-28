#!/usr/bin/env python3
"""Fixed benchmark harness for voice-turn latency.

READ-ONLY during the tuning loop (autoresearch-loop rule 4: never edit the thing
that measures). If this file is genuinely wrong, stop, fix it, void every prior
result, and restart from the baseline.

Measures `turn_ms` from POST /turn and checks the guard metrics defined in
PROGRAM.md. Prints one JSON line so results are machine-readable.

Usage:
    python3 tuning/bench.py <run_id> [repeats]
"""

import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from statistics import median

BASE = "http://127.0.0.1:8787"
TUNING_DIR = Path(__file__).resolve().parent

# Fixed question set. Order is part of the benchmark - do not shuffle.
# Q5 is a conversational filler turn: it needs no memory lookup, so a config
# that still pays full recall cost on it is leaving time on the table.
QUESTIONS = [
    "What is my name?",
    "Who is my wife?",
    "What projects am I working on right now?",
    "What do you know about me?",
    "Got it, thanks.",
]

# Guard checks from PROGRAM.md. Each is (question_index, predicate, label).
# Predicates are deliberately loose on phrasing and strict on substance - we are
# testing whether the fact survived recall, not how it was worded.
GUARDS = [
    (0, lambda s: "vyente" in s.lower() or re.search(r"\bv\b", s.lower()) is not None,
     "knows name"),
    (1, lambda s: "teresa" in s.lower(), "knows wife"),
    (2, lambda s: sum(t in s.lower() for t in
                      ("youni", "405", "voice", "jarvis", "hermes", "lab")) >= 2,
     "names projects"),
    (3, lambda s: "microsoft" in s.lower() and
                  ("lab" in s.lower() or "teresa" in s.lower()),
     "knows background"),
]

MAX_TURN_MS = 15_000  # the server's long-turn handoff boundary


def auth_token() -> str:
    """Scrape the one-time voice-auth key the server injects into the page.

    The key is regenerated on every server start, so it must be re-read after
    each restart rather than cached across runs.
    """
    page = urllib.request.urlopen(BASE + "/", timeout=15).read().decode()
    m = re.search(r'name="voice-auth" content="([^"]+)"', page)
    if not m:
        raise RuntimeError("voice-auth token not found; is the server up?")
    return m.group(1)


def live_config() -> dict:
    """Read the config actually on disk, so the log records what was measured."""
    p = Path("/home/localadmin/.hermes/profiles/voice/hindsight/config.json")
    d = json.loads(p.read_text())
    return {k: d.get(k) for k in
            ("recall_budget", "recall_max_tokens", "recall_types",
             "memory_mode", "auto_recall", "prefetch_method")}


def ask(question: str, token: str, timeout: int = 180) -> dict:
    body = json.dumps({
        "transcript": question,
        "route": True,
        # Marks the traffic as synthetic so it is never attributed to V in the
        # audit log (repo README, browser acceptance rig section).
        "provenance": "synthetic test input",
    }).encode()
    req = urllib.request.Request(
        BASE + "/turn", data=body,
        headers={"Content-Type": "application/json", "x-voice-auth": token},
    )
    started = time.time()
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except Exception as exc:  # noqa: BLE001 - any failure is a run failure
        return {"spoken": "", "turn_ms": int((time.time() - started) * 1000),
                "error": str(exc)}


def run(run_id: str, repeats: int = 3) -> dict:
    token = auth_token()

    # Warm-up, discarded: the first call after a restart pays ACP session and
    # prompt-cache init cost and would inflate the baseline.
    ask("Are you there?", token)

    all_ms: list[int] = []
    answers: dict[int, str] = {}
    crashed = False

    for rep in range(repeats):
        for idx, q in enumerate(QUESTIONS):
            res = ask(q, token)
            if res.get("error"):
                crashed = True
            ms = int(res.get("turn_ms") or 0)
            all_ms.append(ms)
            # Keep the first repeat's answers for guard evaluation; later
            # repeats measure timing only.
            if rep == 0:
                answers[idx] = res.get("spoken", "") or ""

    guard_results = {label: bool(pred(answers.get(i, "")))
                     for i, pred, label in GUARDS}
    no_stall = max(all_ms) <= MAX_TURN_MS
    guard_results["no stall"] = no_stall
    guards_ok = all(guard_results.values()) and not crashed

    return {
        "run": run_id,
        "median_ms": int(median(all_ms)) if all_ms else 0,
        "min_ms": min(all_ms) if all_ms else 0,
        "max_ms": max(all_ms) if all_ms else 0,
        "n": len(all_ms),
        "guards_ok": guards_ok,
        "guards": guard_results,
        "config": live_config(),
        "answers": answers,
        "status": "crash" if crashed else "ok",
    }


if __name__ == "__main__":
    rid = sys.argv[1] if len(sys.argv) > 1 else "adhoc"
    reps = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    print(json.dumps(run(rid, reps), indent=2))
