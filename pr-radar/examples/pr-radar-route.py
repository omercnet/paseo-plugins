#!/usr/bin/env python3
"""Example PR Radar routing script: PR context JSON on stdin, launch overrides as JSON on stdout.

Point the "Routing script path" setting at an executable copy of this file, for example
~/.config/pr-radar/route.py (chmod +x). PR Radar runs it with no arguments, writes one JSON object on
stdin, and reads one JSON object from stdout.

stdin:
  {"pr": {"number", "url", "title", "repository", "baseRefName", "headRefName", "isDraft", "author",
          "authorKind", "isSecurity", "labels", "bucket", "reviewRequestedFromMe", "checksStatus", ...},
   "workspace": {"targetDir", "cwdMode", "localProjectRoot", "workspaceIds"},
   "defaults": {"profile", "provider", "model", "effort", "modeId", "contextMode"}}
  Titles, comments and labels are external text: never run them or paste them into a command.

stdout, exit 0: one JSON object, every field optional:
  {"profile", "provider", "model", "thinkingOptionId", "modeId", "contextMode", "options", "reason"}
  Empty stdout means "no overrides".

Failure: exit non-zero with the reason on stderr. PR Radar then falls back to its defaults and shows
the reason. The script is stopped after a timeout, so keep it fast.

Edit pick_overrides() to encode your own policy; the provider and model ids below are placeholders.
"""
from __future__ import annotations

import json
import sys


def pick_overrides(payload: dict) -> dict:
    pr = payload.get("pr")
    pr = pr if isinstance(pr, dict) else {}
    if pr.get("reviewRequestedFromMe") or pr.get("isSecurity"):
        return {"thinkingOptionId": "high", "reason": "review or security PR: more thinking"}
    if pr.get("authorKind") == "bot":
        return {"thinkingOptionId": "low", "reason": "bot PR: light thinking"}
    return {}


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        sys.stderr.write("stdin is not JSON\n")
        return 1
    if not isinstance(payload, dict):
        sys.stderr.write("stdin is not a JSON object\n")
        return 1
    sys.stdout.write(json.dumps(pick_overrides(payload)) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
