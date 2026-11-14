#!/usr/bin/env python3
"""PR Radar routing adapter: a PR (or issue) signal in, this repo's router's launch overrides out.

  pr-radar-route < context.json

PR Radar (a Paseo plugin, not ours) runs this script with its context JSON on stdin and reads launch overrides as
JSON on stdout. The signal -> route kind mapping lives here, with the routing policy (operator ruling 2026-11-14),
and the answer comes from `route_agent.py route`. This file is the single implementation: pr-radar's
`examples/pr-radar-route.py` is a synced, byte-identical copy of it, so it is stdlib-only and works from either place.

stdin (only the named fields are read; everything else, titles and comments included, is external text and is
never passed on):
  {"pr": {"reviewRequestedFromMe": bool, "isSecurity": bool, "authorKind": str, "repository": "owner/name", ...},
   "settings": {...}}                           (Issues-tab items arrive the same way, reviewRequestedFromMe false)
stdout, exit 0: one JSON object with any of {provider, model, thinkingOptionId, modeId, reason}. `modeId` stays
exactly as routed: yolo/bypassPermissions for every PR, bot and non-djbclark authors included (operator ruling
2026-11-14). `contextMode` and `profile` (PR Radar's launch-profile field) are never set (route_agent picks none).
A dispatch with no `--provider` and a `<`/`>` (`cursor-cloud launch --repo <url>`), or a provider, model, thinking or mode
value with one (`--provider agent/<id from: ...>`), is a template and is refused, never passed on as an override.
Failure: non-zero exit, a reason on stderr, nothing on stdout; PR Radar then falls back to its own defaults and
shows the reason. A router that exits non-zero has its exit code returned; the reason is its JSON `reason` on stdout
(route_agent's "no eligible service with headroom") with the last stderr line after it in parentheses, else its
stderr as is, else "route_agent.py exited with N".

Router choice (first match): $PR_RADAR_ROUTE_AGENT (tests); `route_agent.py` beside this script when the script's
parent directory has config/routing.toml (a djbclark-ade checkout or worktree); ~/src/djbclark-ade/bin/route_agent.py
(the live ADE router); else `route_agent.py` beside this script (a vendored copy).

Exit 0: routed; non-zero: failed (bad stdin, router timeout, router error or unusable router answer).
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROUTER_TIMEOUT_SECONDS = 25
MAX_STDIN_BYTES = 8 * 1024 * 1024
PLACEHOLDER = re.compile(r"[<>]")                            # a template slot in a dispatch value: `<id from: ...>`
SANE_REPO = re.compile(r"[a-z0-9._][a-z0-9._-]*", re.ASCII)  # no leading "-": route_agent's argparse would read it as an option


class RouteFailure(Exception):
    """The adapter could not produce an answer; the message becomes the stderr reason, `code` the exit status."""

    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def _pr(payload: object) -> dict:
    pr = payload.get("pr") if isinstance(payload, dict) else None
    return pr if isinstance(pr, dict) else {}


def pick_kind(payload: dict) -> str:
    """Map a PR signal to a route kind (operator ruling 2026-11-14).

    A review requested from the operator, or a security PR, is judgment work; a bot-authored PR is bulk; anything
    else, an Issues-tab item included, is code.
    """
    pr = _pr(payload)
    if pr.get("reviewRequestedFromMe") or pr.get("isSecurity"):
        return "judgment"
    if pr.get("authorKind") == "bot":
        return "bulk"
    return "code"


def pick_repo(payload: dict) -> str:
    """The bare lowercase repo name of `owner/name`; "" (so no --repo) when absent, outside [a-z0-9._-] or starting with "-"."""
    repo = str(_pr(payload).get("repository") or "").strip()
    if "/" in repo:
        repo = repo.rsplit("/", 1)[-1]
    repo = repo.lower()
    return repo if SANE_REPO.fullmatch(repo) else ""


def parse_dispatch(dispatch: str) -> dict[str, str]:
    """Read --provider (a/b: provider a, model b), --thinking and --mode out of route's `paseo run` line."""
    if not isinstance(dispatch, str):
        return {}
    try:
        tokens = shlex.split(dispatch)
    except ValueError:
        return {}
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


def failure_reason(proc: subprocess.CompletedProcess) -> str:
    """Why a non-zero router run failed. route_agent prints its own reason (the no-headroom case) as JSON on stdout and
    keeps stderr for notes (aiuse fell back to the snapshot file...): the JSON `reason` leads, the last stderr line
    follows in parentheses; with no JSON reason the stderr is passed through whole; else the exit code."""
    stderr = (proc.stderr or "").rstrip("\n")
    try:
        answer = json.loads(proc.stdout)
    except ValueError:
        answer = None
    reason = answer.get("reason") if isinstance(answer, dict) else None
    if isinstance(reason, str) and reason.strip():
        text = " ".join(reason.split())[:300]
        note = " ".join(stderr.strip().splitlines()[-1].split())[:200] if stderr.strip() else ""
        return f"{text} (router: {note})" if note else text
    return stderr or f"route_agent.py exited with {proc.returncode}"


def choose_router() -> Path:
    """The route_agent.py to run (module docstring, "Router choice")."""
    override = os.environ.get("PR_RADAR_ROUTE_AGENT")
    if override:
        return Path(override)
    here = Path(__file__).resolve().parent
    sibling = here / "route_agent.py"
    if (here.parent / "config" / "routing.toml").is_file():
        return sibling
    ade_router = Path.home() / "src" / "djbclark-ade" / "bin" / "route_agent.py"
    return ade_router if ade_router.exists() else sibling


def route(kind: str, repo: str, router: Path | None = None, timeout: float = ROUTER_TIMEOUT_SECONDS) -> dict[str, str]:
    """Run `route_agent.py route` and turn its answer into launch overrides; raises RouteFailure."""
    router = router or choose_router()
    argv = [sys.executable, str(router), "route", "--kind", kind]
    if repo:
        argv.extend(["--repo", repo])
    argv.append("--json")
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, env=os.environ.copy(), timeout=timeout,
                              stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise RouteFailure(f"route_agent.py timed out after {timeout:g}s") from None
    except OSError as exc:
        raise RouteFailure(f"cannot run route_agent.py: {exc.strerror or exc}") from None
    if proc.returncode != 0:
        raise RouteFailure(failure_reason(proc), proc.returncode or 1)
    try:
        answer = json.loads(proc.stdout)
    except ValueError:
        raise RouteFailure("route_agent.py printed unparsable output") from None
    if not isinstance(answer, dict):
        raise RouteFailure("route_agent.py printed a non-object answer")
    result = parse_dispatch(answer.get("dispatch", ""))
    dispatch = answer.get("dispatch")
    if isinstance(dispatch, str) and PLACEHOLDER.search(dispatch) and "provider" not in result:
        # a launch line with no `--provider` (cursor-cloud's `launch --repo <url> ...`) is a template as a whole; its `agent`
        # is not a Paseo provider, so it must not become the provider override below
        raise RouteFailure(f"route_agent.py gave a template dispatch ({dispatch[:60]!r}), not a launch value; "
                           "refusing to override the launch with it")
    if "provider" not in result and answer.get("agent") and isinstance(answer["agent"], str):
        result["provider"] = answer["agent"]
    for field, value in result.items():
        if PLACEHOLDER.search(value):
            raise RouteFailure(f"route_agent.py gave a template {field} ({value[:60]!r}), not a launch value; "
                               "refusing to override the launch with it")
    if answer.get("why") and isinstance(answer["why"], str):
        result["reason"] = f"[{kind}] {answer['why']}"
    if not result:
        raise RouteFailure("route_agent.py answer has no dispatch, agent or why")
    return result


def read_payload(stream) -> dict:
    """The stdin object; empty input is an empty one. Raises RouteFailure on unparsable input."""
    try:
        raw = stream.read(MAX_STDIN_BYTES + 1)
    except (OSError, ValueError):
        raise RouteFailure("stdin is unreadable") from None
    if len(raw) > MAX_STDIN_BYTES:
        raise RouteFailure("stdin is larger than 8 MiB")
    if not raw.strip():
        return {}
    try:
        payload = json.loads(raw)
    except ValueError:
        raise RouteFailure("stdin is not JSON") from None
    return payload if isinstance(payload, dict) else {}


def main() -> int:
    try:
        payload = read_payload(sys.stdin)
        result = route(pick_kind(payload), pick_repo(payload))
    except RouteFailure as exc:
        sys.stderr.write(f"{exc}\n")
        return exc.code
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
