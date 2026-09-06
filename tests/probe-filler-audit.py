#!/usr/bin/env python3
"""Prove a task-aware filler is audited as a filler, not as a diverged reply.

Regression probe for the 2026-09-06 bug: /spoken identified fillers by matching
the five hardcoded static openers, so any task-aware phrase was scored as a
DIVERGED answer. Uses a low VOICE_FILLER_MS via the test hook rather than
waiting for a genuinely slow turn.
"""
import json
import subprocess
import sys
import time
import urllib.request

BASE = "http://localhost:8787"
LOG = "/home/localadmin/homelab/realtime-ai-voice/logs"


def page_token():
    html = urllib.request.urlopen(BASE + "/").read().decode()
    return html.split('voice-auth" content="')[1].split('"')[0]


def post(path, payload, auth):
    req = urllib.request.Request(
        BASE + path, json.dumps(payload).encode(),
        {"Content-Type": "application/json", "X-Voice-Auth": auth})
    return urllib.request.urlopen(req, timeout=300)


def tail(name):
    with open(f"{LOG}/{name}") as f:
        lines = [json.loads(l) for l in f if l.strip()]
    return lines[-1] if lines else {}


def count(name):
    with open(f"{LOG}/{name}") as f:
        return sum(1 for l in f if l.strip())


def main():
    auth = page_token()
    before = count("fillers.log")

    # A question guaranteed to outrun the filler threshold.
    q = ("Read every README under my projects folder, count the words in each, "
         "and tell me which one is longest.")
    print(f"asking a slow question to force a filler...")
    r = json.load(post("/turn", {
        "item_id": f"probe-{int(time.time())}", "transcript": q,
        "provenance": "synthetic test input", "route": True}, auth))
    print(f"  turn_ms={r.get('turn_ms')} fillerFired={r.get('fillerFired')}")

    if count("fillers.log") == before:
        print("\nNO DATA: the turn beat the filler threshold, so nothing fired.")
        print("Lower it and retry:  VOICE_FILLER_MS=1500 (restart the service)")
        return 2

    f = tail("fillers.log")
    print(f"  filler emitted: {f['text']!r}  (source={f.get('source')})")

    post("/spoken", {"spokenText": f["text"]}, auth)
    last = tail("voice-audit.log")
    print(f"  audit recorded: kind={last.get('kind')} verdict={last.get('verdict','-')}")

    if last.get("kind") == "filler":
        print("\nPASS — task-aware filler classified as a filler.")
        return 0
    print("\nFAIL — filler was scored as a reply (the 2026-09-06 bug).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
