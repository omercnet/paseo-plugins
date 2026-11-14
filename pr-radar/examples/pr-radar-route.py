#!/usr/bin/env python3
"""Example PR Radar routing script backed by djbclark-ade's route_agent.py.

Reads PR Radar context JSON from stdin and prints agent launch overrides as JSON:
  {
    "provider": "claude",
    "model": "sonnet",
    "thinkingOptionId": "high",
    "modeId": "bypassPermissions"
  }
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


def pick_kind(payload: dict) -> str:
    pr = payload.get("pr") or {}
    if pr.get("reviewRequestedFromMe") or pr.get("isSecurity"):
        return "judgment"
    if pr.get("authorKind") == "bot":
        return "bulk"
    return "code"


def parse_dispatch(dispatch: str) -> dict[str, str]:
    tokens = shlex.split(dispatch)
    out: dict[str, str] = {}
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--provider" and i + 1 < len(tokens):
            prov = tokens[i + 1]
            if "/" in prov:
                provider, model = prov.split("/", 1)
                out["provider"] = provider
                out["model"] = model
            else:
                out["provider"] = prov
            i += 2
            continue
        if tok == "--thinking" and i + 1 < len(tokens):
            out["thinkingOptionId"] = tokens[i + 1]
            i += 2
            continue
        if tok == "--mode" and i + 1 < len(tokens):
            out["modeId"] = tokens[i + 1]
            i += 2
            continue
        i += 1
    return out


def main() -> int:
    raw = sys.stdin.read().strip()
    payload = json.loads(raw) if raw else {}
    kind = pick_kind(payload)

    local_router = Path(__file__).resolve().with_name("route_agent.py")
    ade_router = Path.home() / "src" / "djbclark-ade" / "bin" / "route_agent.py"
    router_path = ade_router if ade_router.exists() else local_router

    proc = subprocess.run(
        [sys.executable, str(router_path), "route", "--kind", kind, "--json"],
        capture_output=True,
        text=True,
        env=os.environ.copy(),
        timeout=25,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or f"route_agent.py exited with {proc.returncode}\n")
        return proc.returncode or 1

    route = json.loads(proc.stdout)
    result = parse_dispatch(route.get("dispatch", ""))
    if "provider" not in result and route.get("agent"):
        result["provider"] = route["agent"]
    if route.get("why"):
        result["reason"] = route["why"]
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
