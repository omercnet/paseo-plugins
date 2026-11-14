#!/usr/bin/env python3
"""Pick which vendor should run a piece of work, from capability and headroom.

Routing here has been manual, which means it defaults to whatever is familiar.
Measured on 2026-08-23: antigravity, opencode-go, zai and devin (all since retired from this
router, 2026-11-06) were all at
roughly 0% used while claude carried the entire session. That is paid capacity
expiring unused every cycle, and it repeats.

Two inputs decide a route:

1. **Capability** — what each service is actually good at, from
   `docs/model-routing.md`'s judgment section, made machine-readable below.
2. **Headroom** — live quota from `aiuse`, and from `paseo usage ls --json` as a second source
   (slim-down E7, 2026-11-07).

The headroom half has a hard constraint: a full `aiuse --json` probe takes
**~46 seconds** (measured). Nothing that slow can sit inside a routing
decision — so this never runs it. `aiuse` already persists every run as JSON
under `~/.cache/aiuse/snapshots/`, keeping `latest.json` current, and a
launchd job (`com.djbclark.aiuse`, StartInterval 900) refreshes it every 15
minutes. Since 2026-10-20 routing asks `aiuse --available --json` instead (argv list,
20 s timeout; it reads that same cache in well under a second), because aiuse applies
the operator credits override (`aiuse set-credits`), Admin API readings and grant
expiry at read time and the file never carries them. A pool the snapshot knows that
a fresh `--available` leaves out reads 0% left (exhausted, excluded or hidden). If aiuse
is missing, fails, times out or prints malformed JSON, routing logs that on stderr,
falls back to the snapshot file (surfaced as `quota_source` in plan/route JSON and a
WARNING in plan text) and a stale or missing snapshot degrades to capability-only routing
rather than hanging. Env: `ROUTE_AGENT_AIUSE_JSON=<path>` feeds canned output (tests; reported
as source `canned`, logged on stderr each use, and it takes precedence over
`ROUTE_AGENT_AIUSE=off` and `AIUSE_SNAPSHOT`), `ROUTE_AGENT_AIUSE=off` or `AIUSE_SNAPSHOT`
pins the file-only read, `ROUTE_AGENT_AIUSE_BIN` names the binary,
`ROUTE_AGENT_AIUSE_TIMEOUT` is seconds in (0, 60] (default 20). The spawn is memoised for 30 s;
`load_snapshot(bypass_memo=True)` skips the memo (acp-dispatch's post-wait plenty-gate looks).

**Paseo is the second quota source and the registry (2026-11-07, slim-down E7).** `paseo usage ls --json`
(`usage_from_paseo`) gives one report per `sourceId`: a report whose `status` is `available` contributes its
windows (`usedPct`/`remainingPct`/`resetsAt`) and `balances` (as percentages of `limit`); any other status is
**unknown**, never a pass. Its pools are folded into the aiuse reading with the same `_merge_pool` rule (the
tightest known reading wins; an unknown never loosens one), and `quota_source_info()["pools"]` says which source
each pool came from. Env: `ROUTE_AGENT_PASEO=off` drops both Paseo reads (the test suite sets it),
`ROUTE_AGENT_PASEO_BIN` names the binary, `ROUTE_AGENT_PASEO_TIMEOUT` is seconds in (0, 60] (default 15),
`ROUTE_AGENT_PASEO_USAGE_JSON=<path>` feeds canned `usage ls` output (tests). The usage read is memoised for 30 s.
The Claude reading of that merged snapshot (`claude_quota_state`) is what the frontier allowance judges
(bin/ade_gates.py; it read the deleted quota guard's state file until 2026-11-07).

**Services are discovered, not hardcoded.** The roster changes: providers appear in Paseo and in aiuse,
plans lapse. So the service list is built at call time from the curated profiles in config/routing.toml plus:

1. `paseo provider ls --json` (`paseo_providers`): the rows whose `enabled` is `"Enabled"` and whose
   `status` is `available`; a row still `loading` (right after the daemon starts) is re-read twice over 6 s
   and then treated as absent, with a note on stderr. `paseo provider models <p> --json` gives a provider's
   model ids (`provider_models`, cached per process) for `services --check-models`.
2. whatever providers the quota snapshot reports.

Every name passes through `ALIASES` before it becomes a service (Paseo's `opencode` provider is the
`opencode-go` pool), and the curated capability profiles are applied as an *overlay*. A provider nobody has
profiled still routes (conservatively) instead of being invisible, unless `never_route` names it.

The operator's standing routing rules are encoded as hard constraints, not
preferences, because they encode consequences a score cannot see:

- free and chronically-unused pools first for bulk work;
- judgment goes to claude's Opus 5.5 at high first, omp's Opus next, and (2026-10-25) codex's gpt-6.1-sol
  at high only while every window has plenty_min left; the two frontier models, Claude
  Fable 5.2 and codex's gpt-6-astra, are reached ONLY through the explicit
  `frontier` kind, at most one slice per pool per wave (two on claude under the
  standing allowance of 2026-10-27 while the Claude reading passes: docs/gates.md), for work that really
  needs them (operator 2026-10-18: a wave of four astra slices emptied
  codex's 5-hour window and every one stopped; Fable at xhigh should almost
  never run). Everyday work goes to the other pools, and ALSO to codex's
  everyday models (gpt-6.1-sol for judgment and code, gpt-6-luna for bulk and mechanical;
  never astra) while its quota is plentiful (operator 2026-10-25: "if we have
  lots of codex quota and it is the best of available options we can use it for
  non-frontier"): a service's `plenty_kinds` are eligible only while its binding
  headroom (the tightest window, 5-hour and weekly alike) is at least
  `PLENTY_MIN` ([routing].plenty_min, 20), and with no fresh reading they are
  not, so below it codex is frontier-only again; inside that gate it competes
  on the normal ranking, it is not forced first;
- Fable is a sublimit (at most 50%) of the SAME Claude weekly window, not a
  separate allowance: a Fable run bills the shared window too;
- there is no reserve pool now (copilot, the one reserve with a hard floor, retired from the router
  2026-11-06: Paseo's Copilot provider replaces the CLI; the grok CLI's SuperGrok pool, a reserve until
  2026-10-18, retired 2026-11-07; grok-bot is Cursor-billed and never a slice target);
- hermes is never a delegation target (gated, never discovered as a routable
  service here); omp is an ordinary tier since 2026-10-19 (operator): its Claude
  API credits are an expiring grant, first for `api-only` work (rank 1) and otherwise for `code`/`bulk` slices, so they are spent
  before each monthly reset; `grant_days` gives it the burn-first bonus while the
  balance is far above an even spend over the month;
- **never** route a slice to clinepass (NEVER_ROUTE) — it is the Hindsight/hermes
  lifeline and stays only in `hermes_chain`;
- the prepaid tier (opencode-zen) is retired until an
  explicit operator top-up.

Every route comes with a `--model [--effort]` suggestion and the native
`paseo run --provider …` launch line (`cursor-cloud launch` for the Cursor Cloud row;
the Wave 6 `acp-dispatch` shim is transitional only);
the context window is the caller's choice (the agent's default unless the slice reads a whole corpus or a
long log).

Usage:
    route_agent.py route --kind bulk
    route_agent.py route --kind judgment --json
    aiuse --available --live --json # (not route_agent) force a fresh quota collect; this script only reads aiuse's snapshot
    route_agent.py show             # cache age, headroom, pace, expected waste, source per pool
    route_agent.py services [--check-models]   # the roster; --check-models: every suggested model in its
                                    # provider's `paseo provider models` list (exit 1 when one is not)
    route_agent.py calibrate [--since DAYS] [--json] [--min N]
    route_agent.py adjust --kinds code,bulk [--dry-run] [--json]   # plan with hold/restore hysteresis (W8)
"""
from __future__ import annotations

import argparse
import contextlib
import glob
import json
import math
import os
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, field, fields
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ade_config  # versioned config and isolated legacy routing override
import ade_gates  # the frontier gate: config/gates.toml [frontier], docs/gates.md
import model_tiers as _model_tiers  # config/model-tiers.toml roles → ids

DEFAULT_SNAPSHOT = Path.home() / ".cache" / "aiuse" / "snapshots" / "latest.json"
SNAPSHOT = Path(os.environ.get("AIUSE_SNAPSHOT") or DEFAULT_SNAPSHOT)
STALE_HARD = 6 * 3600      # beyond this, treat headroom as unknown
STALE_SOFT = 25 * 60       # aiuse's own `fresh` threshold; older = re-collect before a wave

# KINDS, BURN_FIRST_* and the curated SERVICES rows are
# loaded from effective config (see load_policy / load_effective_policy / apply_policy below).


@dataclass(frozen=True)
class Service:
    name: str                       # aiuse provider key
    cli: str                        # how it is actually invoked
    # kind -> fitness rank, lower is better. Per-kind rather than one number
    # because fitness is not a single axis: one pool is the best home for
    # bulk and the wrong home for careful coding, and a flat rank cannot say
    # both.
    good_at: dict[str, int]
    billing: str                    # subscription | free | prepaid
    note: str = ""
    never_bulk: bool = False        # infrastructure lifeline
    retired: bool = False           # excluded until an operator decision
    judgment_tier: bool = False     # trusted for high-stakes calls
    # How this service may LEGITIMATELY be reached. Researched 2026-08-24;
    # this is a licensing constraint, not a preference, so it gates hard.
    #   "api"      - we hold credentials whose terms permit programmatic use,
    #                so Hermes may call it directly as a provider.
    #   "cli-only" - the subscription covers use through the vendor's OWN
    #                client. Shelling out to that CLI is fine; wiring the
    #                endpoint into Hermes as a generic provider is not.
    #   "forbidden"- third-party clients explicitly violate the terms.
    access: str = "cli-only"
    # True when the only way to reach this is as a Hermes provider, with no
    # command Claude Code can invoke. Nothing currently sets it: opencode-zen
    # (free and paid) is reachable from Claude through the `opencode` TUI, so
    # the earlier assumption that it was Hermes-only was wrong. Kept because
    # a genuinely Hermes-only provider would otherwise silently win Claude
    # routing decisions it cannot serve.
    hermes_only: bool = False
    # Static fallback for burn-first when expected waste at reset is unknown.
    # Prefer computed waste ≥ burn_first_waste_min (2026-10-18). When waste is
    # known this flag is ignored; when unknown, `route` still applies
    # BURN_FIRST_BONUS above BURN_FIRST_MIN.
    burn_first: bool = False
    # Set when this service is ONE of several independent model-family pools
    # that a single aiuse provider reports: (aiuse provider, window
    # `pool_family`). Windows of that family are measured for this service
    # alone; the provider's other windows stay with the provider's own
    # service. Add a row with `pool=` to give any provider's second pool its
    # own routing entry (cursor, ...) once aiuse reports it. Do NOT
    # use it for a model sublimit of a shared pool (Claude's `fable`): that
    # one is bounded by the parent windows and must stay with them.
    pool: tuple[str, str] | None = None
    # Primary family for the provider-named service; absent metadata never matches.
    pool_family: str | None = None
    # Most slices one bigteam wave should put on this service at once. Pools
    # with a burst limit or a dependant get a low cap so `plan` spreads a wave
    # over several pools instead of drowning the best-ranked one.
    max_parallel: int = 4
    # The Paseo provider (the acp-dispatch agent name) when it differs from the pool name
    # (opencode-go -> opencode, cursor-auto -> cursor, ...).
    agent: str = ""
    # kind -> "<model> [--effort LEVEL]" to pass to acp-dispatch.
    # Ids as `paseo provider models <agent> --json` lists them (`route_agent.py services --check-models`).
    models: dict[str, str] = field(default_factory=dict)
    # A reserve pool's hard floor: never route to it with less than this much
    # of its binding window left, whatever `min_headroom` says (none now;
    # copilot was one, grok was one until 2026-10-18).
    reserve_floor: float = 0.0
    # True when `reserve_floor` only makes the pool fail closed without a measured reading (pi,
    # 2026-11-03, retired 2026-11-06): it is a normal pool, not a reserve, so route() omits the RESERVE advice.
    measured_only: bool = False
    # Days in the grant period when this pool is an expiring dollar grant rather than a
    # rolling window (omp's Claude API credits, 2026-10-19): aiuse reports an expiry
    # (`resets_at`) but no `window_minutes` or pace, so expected_waste() cannot compute
    # waste and the pool would never earn the burn-first bonus. With grant_days set,
    # grant_waste() measures the balance against an even spend over the period instead.
    grant_days: int = 0
    # Name of a readiness probe in READY_PROBES. A service whose probe fails is skipped by
    # route() for every kind that goes through acp-dispatch (not `api-only`, which is the
    # caller's own API call), so the router never hands out a slice that cannot start.
    ready_probe: str = ""
    # Name of another service whose aiuse row this one draws on (cursor-cloud bills at API
    # price against the Cursor pool, 2026-10-20): load_snapshot copies that row's reading
    # to this name unless aiuse reports one of its own.
    shares_pool: str = ""
    # Kinds that need a plentiful quota: eligible only while the pool's tightest window holds at
    # least PLENTY_MIN percent ([routing].plenty_min). Codex's everyday kinds (operator 2026-10-25).
    plenty_kinds: tuple[str, ...] = ()
    # Services this one is a FALLBACK behind (Gemini 4 Argon behind codex and claude, operator 2026-10-31): it is used
    # only while at least ONE named service is short (not usable: see pool_usable), never while all of them could take
    # the kind, whatever its score. route() and acp-dispatch apply the same predicate (`fallback_block`). A per-wave
    # cap or an `exclude` does not make a named service short. A fallback with no fresh reading fails closed.
    fallback_after: tuple[str, ...] = ()
    # The aiuse window label that bounds this pool, named in a refusal when its reading is missing ("Gemini 4 Argon weekly").
    window: str = ""

    @property
    def acp_agent(self) -> str:
        return self.agent or self.name

    def eligible(self, kind: str, quota: dict[str, Any] | None = None, *,
                 any_headroom: bool = False) -> bool:
        """Can this service take `kind`?  `plenty_kinds` also need a fresh reading of at least
        PLENTY_MIN in `quota[name]["remaining"]` (the tightest window) AND a reading for every
        window the pool lists (`plenty_remaining`: one unknown window means the gate cannot
        say every window has PLENTY_MIN left, 2026-10-25), else they are not eligible; no
        `quota` means no reading, so those kinds fail closed.  `any_headroom` skips that gate,
        for questions about the profile alone (calibrate's history)."""
        if self.retired or self.hermes_only:
            return False
        if ((self.pool or self.pool_family or self.shares_pool) and not any_headroom
                and plenty_remaining((quota or {}).get(self.name)) is None):
            return False
        if self.measured_only and not any_headroom:
            info = (quota or {}).get(self.name) or {}
            left, age = plenty_remaining(info), _clean_age(info.get("age_s"))
            if (isinstance(left, bool) or _pct(left) is None or age is None
                    or age > STALE_SOFT or info.get("requires_operator_approval") is True):
                return False
        if kind in ("bulk", "mechanical") and self.never_bulk:
            return False
        if kind in ("judgment", "frontier") and not self.judgment_tier:
            return False
        if kind not in self.good_at:
            return False
        if kind in self.plenty_kinds and not any_headroom:
            remaining = plenty_remaining((quota or {}).get(self.name))
            return remaining is not None and remaining >= PLENTY_MIN
        return True

    def rank_for(self, kind: str) -> int:
        return self.good_at[kind]


def plenty_remaining(info: dict[str, Any] | None) -> float | None:
    """A pool's binding remaining percent for the `plenty_kinds` gate, or None when it is not
    known for every window: no reading, or any window the reading lists as null (an aiuse
    window with `remaining_percent: null` is a window nobody measured; the pool's `remaining`
    is then only the tightest of the KNOWN ones, which cannot show every window is plentiful)."""
    info = info or {}
    remaining = info.get("remaining")
    if remaining is None or any(v is None for v in (info.get("windows") or {}).values()):
        return None
    return remaining


# Legacy policy path for explicit reads. Runtime initialization uses load_effective_policy.
def resolve_policy_path() -> Path:
    return Path(os.environ.get("ROUTING_POLICY") or
                (Path(__file__).resolve().parent.parent / "config" / "routing.toml"))


POLICY_PATH = resolve_policy_path()
POLICY: dict[str, Any] = {}
POLICY_PROVENANCE: dict[str, Any] = {}
MODEL_TIERS: _model_tiers.Tiers
# Model caps share their provider's subscription windows; refreshed with tiers on reload.
SUBLIMIT_FAMILIES: tuple[str, ...]
SERVICE_KEYS = {f.name for f in fields(Service)}
_SERVICE_REQUIRED = ("name", "cli", "good_at", "billing")
# The orchestrating session's own model, [lead] in the policy file (2026-10-23).  LEAD_KEYS are
# required; `pipeline_effort` (djbclark 2026-10-23: a pipeline-only lead runs Sonnet at medium) is
# optional and defaults to LEAD_PIPELINE_EFFORT_DEFAULT so an older policy file still loads.
LEAD_KEYS = ("model", "effort", "pipeline_model")
LEAD_PIPELINE_EFFORT_DEFAULT = "high"
# The effort levels a Claude lead can be set to: Paseo's CLAUDE_EFFORT_LEVELS (its `xhigh` list,
# Paseo.app app.asar, 2026-10-23) and Claude Code's `/effort` / SDK `effort` type.  Not acp-run's
# wider list (none, minimal, ultra, default): no Claude surface takes those.
CLAUDE_EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
LEAD_ALL_KEYS = LEAD_KEYS + ("pipeline_effort",)
# `fable_lead` (operator 2026-11-07: "Fable leads are allowed for now, with an easy way to turn them off later"): the one
# switch for a lead session on Fable. Optional and read with .get: absent means false, the 2026-10-23 "never a Fable lead"
# rule, so an older policy file keeps it. LEAD_FABLE_ALLOWED is the loaded value; context_size_nudge.py reads the same key.
LEAD_SWITCHES = ("fable_lead",)
LEAD_FABLE_ALLOWED = False

# Populated by apply_policy from the TOML; names and types match the former
# module-level literals so every caller and test keeps working.
SERVICES: tuple[Service, ...]
BY_NAME: dict[str, Service]
KINDS: tuple[str, ...]
BURN_FIRST_MIN: float
BURN_FIRST_BONUS: float
BURN_FIRST_WASTE_MIN: float
PACE_PENALTY_ABOVE: float
PACE_PENALTY: float
PACE_PENALTY_JUDGMENT_FACTOR: float
PLENTY_MIN: float
QUALITY_MAX_RANK_GAP: dict[str, int]
DEFAULT_PROFILE: dict[str, int]
NEVER_ROUTE: frozenset[str]
OPERATOR_GATED: frozenset[str]
ALIASES: dict[str, str]
DISPATCH_EXTRA: dict[str, str]
HERMES_MODELS: dict[str, list[str]]
HERMES_PROVIDER_NAME: dict[str, str]
SUBSTRATE_LIFELINE: frozenset[str]
CALIBRATE_MIN_OUTCOMES: int
CALIBRATE_MIN_PEERS: int
CALIBRATE_SUGGEST_WORSE_BELOW: float
CALIBRATE_SUGGEST_WORSE_DELTA: int
CALIBRATE_SUGGEST_BETTER_ABOVE: float
CALIBRATE_SUGGEST_BETTER_DELTA: int


def load_policy(path: Path | str) -> dict[str, Any]:
    """Parse and validate config/routing.toml (or ROUTING_POLICY).

    Each [[service]] may only use Service field names; name/cli/good_at/billing
    are required. Raises ValueError naming the file and the entry on bad input.
    """
    path = Path(path)
    try:
        with path.open("rb") as fh:
            data = tomllib.load(fh)
    except OSError as e:
        raise ValueError(f"routing policy {path}: {e}") from e
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"routing policy {path}: {e}") from e

    services = data.get("service")
    if services is None:
        raise ValueError(f"routing policy {path}: missing [[service]] entries")
    if not isinstance(services, list):
        raise ValueError(f"routing policy {path}: 'service' must be an array of tables")  # noqa: TRY004  (ValueError is the loader's documented error)

    for i, entry in enumerate(services):
        label = entry.get("name") if isinstance(entry, dict) else i
        if not isinstance(entry, dict):
            raise ValueError(f"routing policy {path}: [[service]] entry {i} is not a table")  # noqa: TRY004  (ValueError is the loader's documented error)
        unknown = set(entry) - SERVICE_KEYS
        if unknown:
            raise ValueError(
                f"routing policy {path}: [[service]] {label!r}: "
                f"unknown key(s) {sorted(unknown)}")
        missing = [k for k in _SERVICE_REQUIRED if k not in entry]
        if missing:
            raise ValueError(
                f"routing policy {path}: [[service]] {label!r}: "
                f"missing required key(s) {missing}")
        if entry.get("pool_family") is not None and not (
                isinstance(entry["pool_family"], str) and entry["pool_family"]):
            raise ValueError(f"routing policy {path}: invalid pool_family for {label!r}")
        pool = entry.get("pool")
        if pool is not None and not (isinstance(pool, list) and len(pool) == 2
                                       and all(isinstance(x, str) for x in pool)):
            raise ValueError(
                f"routing policy {path}: [[service]] {label!r}: "
                f"pool must be a 2-element string array, got {pool!r}")
    for section in ("routing", "dispatch", "hermes", "calibrate"):
        if section not in data or not isinstance(data[section], dict):
            raise ValueError(f"routing policy {path}: missing [{section}] table")
    substrate = data.get("substrate")
    if substrate is not None:
        lifeline = substrate.get("lifeline", []) if isinstance(substrate, dict) else None
        if not (isinstance(lifeline, list) and all(isinstance(x, str) for x in lifeline)):
            raise ValueError(f"routing policy {path}: [substrate] must be a table whose "
                             "lifeline is an array of service names")
    lead = data.get("lead")
    if lead is not None:
        if not isinstance(lead, dict):
            raise ValueError(f"routing policy {path}: [lead] must be a table")
        unknown = set(lead) - set(LEAD_ALL_KEYS) - set(LEAD_SWITCHES)
        if unknown:
            raise ValueError(f"routing policy {path}: [lead] unknown key(s) {sorted(unknown)}")
        if not all(isinstance(lead.get(k), str) and lead[k] for k in LEAD_KEYS):
            raise ValueError(f"routing policy {path}: [lead] must be a table with non-empty string keys "
                             + ", ".join(LEAD_KEYS))
        lead.setdefault("pipeline_effort", LEAD_PIPELINE_EFFORT_DEFAULT)
        if not isinstance(lead.get("fable_lead", False), bool):
            raise ValueError(f"routing policy {path}: [lead] fable_lead must be true or false, "
                             f"got {lead.get('fable_lead')!r}")
        for key in ("effort", "pipeline_effort"):
            if lead[key] not in CLAUDE_EFFORT_LEVELS:
                raise ValueError(f"routing policy {path}: [lead] {key} {lead[key]!r} must be one of "
                                 + ", ".join(CLAUDE_EFFORT_LEVELS))
    return data


def _service_from_entry(entry: dict[str, Any]) -> Service:
    kwargs = dict(entry)
    if kwargs.get("pool") is not None:
        a, b = kwargs["pool"]
        kwargs["pool"] = (a, b)
    kwargs["good_at"] = {str(k): int(v) for k, v in kwargs["good_at"].items()}
    kwargs["plenty_kinds"] = tuple(str(k) for k in kwargs.get("plenty_kinds") or ())
    kwargs["fallback_after"] = tuple(str(k) for k in kwargs.get("fallback_after") or ())
    if "models" in kwargs and kwargs["models"] is not None:
        kwargs["models"] = {str(k): str(v) for k, v in kwargs["models"].items()}
    return Service(**kwargs)


def apply_policy(data: dict[str, Any]) -> None:
    """Install a loaded policy dict as this module's routing constants."""
    global POLICY, SERVICES, BY_NAME, KINDS, BURN_FIRST_MIN, BURN_FIRST_BONUS
    global BURN_FIRST_WASTE_MIN, PACE_PENALTY_ABOVE, PACE_PENALTY
    global PACE_PENALTY_JUDGMENT_FACTOR, QUALITY_MAX_RANK_GAP
    global PLENTY_MIN, DEFAULT_PROFILE, NEVER_ROUTE, OPERATOR_GATED
    global ALIASES, DISPATCH_EXTRA, DISPATCH_MODES, HERMES_MODELS
    global HERMES_PROVIDER_NAME
    global SUBSTRATE_LIFELINE
    global CALIBRATE_MIN_OUTCOMES, CALIBRATE_MIN_PEERS
    global CALIBRATE_SUGGEST_WORSE_BELOW
    global CALIBRATE_SUGGEST_WORSE_DELTA, CALIBRATE_SUGGEST_BETTER_ABOVE
    global CALIBRATE_SUGGEST_BETTER_DELTA
    global LEAD_FABLE_ALLOWED, CANARY_POOLS

    POLICY = data
    try:
        routing = data["routing"]
        dispatch = data["dispatch"]
        hermes = data["hermes"]
        calibrate = data["calibrate"]

        KINDS = tuple(routing["kinds"])
        canary = routing.get("canary_pools", [])
        if not isinstance(canary, list) or not all(isinstance(p, str) and p for p in canary):
            raise ValueError("routing.canary_pools must be a list of non-empty pool names")
        CANARY_POOLS = frozenset(canary)
        BURN_FIRST_MIN = float(routing["burn_first_min"])
        BURN_FIRST_BONUS = float(routing["burn_first_bonus"])
        BURN_FIRST_WASTE_MIN = float(routing["burn_first_waste_min"])
        PACE_PENALTY_ABOVE = float(routing["pace_penalty_above"])
        PACE_PENALTY = float(routing["pace_penalty"])
        PACE_PENALTY_JUDGMENT_FACTOR = float(routing["pace_penalty_judgment_factor"])
        PLENTY_MIN = float(routing["plenty_min"])
        QUALITY_MAX_RANK_GAP = {str(k): int(v) for k, v in
                                (routing.get("quality_max_rank_gap") or {}).items()}
        DEFAULT_PROFILE = {str(k): int(v) for k, v in routing["default_profile"].items()}

        # [routing].never_route / aliases (the [discovery] table until 2026-11-07); a name the dispatch gate
        # holds for operator approval is never discovered either.
        NEVER_ROUTE = frozenset(str(x) for x in routing.get("never_route") or [])
        OPERATOR_GATED = frozenset(str(x) for x in dispatch["operator_gated"])
        ALIASES = {str(k): str(v) for k, v in (routing.get("aliases") or {}).items()}

        DISPATCH_EXTRA = {str(k): str(v) for k, v in (dispatch.get("extra") or {}).items()}
        modes = dispatch.get("unattended_modes", {})
        if not isinstance(modes, dict) or not all(
                isinstance(k, str) and k and isinstance(v, str) and v
                for k, v in modes.items()):
            raise ValueError("dispatch.unattended_modes must map providers to non-empty mode IDs")
        DISPATCH_MODES = dict(modes)
        HERMES_MODELS = {str(k): [str(m) for m in v]
                          for k, v in (hermes.get("models") or {}).items()}
        HERMES_PROVIDER_NAME = {str(k): str(v)
                                for k, v in (hermes.get("provider_name") or {}).items()}
        SUBSTRATE_LIFELINE = frozenset(
            str(x) for x in ((data.get("substrate") or {}).get("lifeline") or []))

        CALIBRATE_MIN_OUTCOMES = int(calibrate["min_outcomes"])
        CALIBRATE_MIN_PEERS = int(calibrate["min_peers"])
        CALIBRATE_SUGGEST_WORSE_BELOW = float(calibrate["suggest_worse_below"])
        CALIBRATE_SUGGEST_WORSE_DELTA = int(calibrate["suggest_worse_delta"])
        CALIBRATE_SUGGEST_BETTER_ABOVE = float(calibrate["suggest_better_above"])
        CALIBRATE_SUGGEST_BETTER_DELTA = int(calibrate["suggest_better_delta"])
    except KeyError as e:
        raise ValueError(
            f"routing policy {POLICY_PATH}: missing key {e.args[0]!r}"
        ) from e

    SERVICES = tuple(_service_from_entry(e) for e in data["service"])
    BY_NAME = {s.name: s for s in SERVICES}
    LEAD_FABLE_ALLOWED = (data.get("lead") or {}).get("fable_lead", False) is True


def _load_runtime_config(
    *, root: Path | None = None, home: Path | None = None,
    environ: dict[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], _model_tiers.Tiers]:
    """Validate routing and model tiers from one effective-config snapshot.

    The effective schema deliberately leaves routing leaves open. Apply the
    pure legacy reader's shape/default contract after all overlays as well;
    importing this reader never imports live routing back through ade_config.
    Explicit load_policy(path) remains an isolated legacy-format file read.
    """
    effective = ade_config.load_effective(root=root, home=home, environ=environ,
                                          domains=ade_config.ROUTER_DOMAINS)
    data = ade_config.project_routing_domain(effective.data)
    source = Path(effective.provenance["routing_source"])
    ade_config.validate_legacy_routing_shape(data, source)
    provenance = {key: effective.provenance[key]
                  for key in ("routing_source", "new_config", "local_config")}
    info = effective.provenance["model_tiers_info"]
    tiers = _model_tiers.from_dict(
        effective.data["model_tiers"],
        path=Path(effective.provenance["model_tiers_source"]),
        source=info["source"], error=info["error"],
    )
    if any(entry["name"] == "claude" for entry in data["service"]):
        # A structurally valid tier table may omit a vendor. Validate the
        # configured Claude service's fallback helpers before publishing state.
        _model_tiers.pool("claude", "frontier", tiers)
        _model_tiers.resolve("claude", "judgment", "claude", tiers)
    return data, provenance, tiers


def load_effective_policy(
    *, root: Path | None = None, home: Path | None = None,
    environ: dict[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read validated runtime routing; leave explicit legacy reads isolated."""
    data, provenance, _ = _load_runtime_config(root=root, home=home, environ=environ)
    return data, provenance


def reload_policy(path: Path | str | None = None) -> dict[str, Any]:
    """Reload effective runtime config, or only the explicit legacy `path`."""
    global POLICY_PATH, POLICY_PROVENANCE, MODEL_TIERS, SUBLIMIT_FAMILIES
    if path is None:
        data, provenance, tiers = _load_runtime_config()
    else:
        data = load_policy(path)
        provenance = {"routing_source": str(path), "new_config": None, "local_config": None}
        tiers = _model_tiers.load(use_cache=False)
    # Complete tier derivation before apply_policy can publish routing constants.
    _model_tiers.frontier_tokens(tiers)
    families = _model_tiers.sublimit_families(tiers) or ("fable",)
    POLICY_PATH = Path(provenance["routing_source"])
    POLICY_PROVENANCE = provenance
    apply_policy(data)
    MODEL_TIERS = tiers
    SUBLIMIT_FAMILIES = families
    return data


def policy_public() -> dict[str, Any]:
    """Effective policy as a JSON-serialisable dict (services expanded)."""
    def svc_row(s: Service) -> dict[str, Any]:
        return {
            "name": s.name, "cli": s.cli, "good_at": dict(s.good_at),
            "billing": s.billing, "note": s.note, "never_bulk": s.never_bulk,
            "retired": s.retired, "judgment_tier": s.judgment_tier,
            "access": s.access, "hermes_only": s.hermes_only,
            "burn_first": s.burn_first,
            "pool": list(s.pool) if s.pool else None, "pool_family": s.pool_family,
            "max_parallel": s.max_parallel, "agent": s.agent,
            "models": dict(s.models), "reserve_floor": s.reserve_floor,
            "grant_days": s.grant_days, "ready_probe": s.ready_probe,
            "shares_pool": s.shares_pool, "plenty_kinds": list(s.plenty_kinds),
            "fallback_after": list(s.fallback_after), "window": s.window,
        }
    return {
        "path": str(POLICY_PATH),
        "provenance": dict(POLICY_PROVENANCE),
        "frontier_gate": frontier_gate(),
        "routing": {
            "kinds": list(KINDS),
            "burn_first_min": BURN_FIRST_MIN,
            "burn_first_bonus": BURN_FIRST_BONUS,
            "burn_first_waste_min": BURN_FIRST_WASTE_MIN,
            "pace_penalty_above": PACE_PENALTY_ABOVE,
            "pace_penalty": PACE_PENALTY,
            "pace_penalty_judgment_factor": PACE_PENALTY_JUDGMENT_FACTOR,
            "plenty_min": PLENTY_MIN,
            "default_profile": dict(DEFAULT_PROFILE),
            "never_route": sorted(NEVER_ROUTE),
            "aliases": dict(ALIASES),
        },
        "calibrate": {
            "min_outcomes": CALIBRATE_MIN_OUTCOMES,
            "min_peers": CALIBRATE_MIN_PEERS,
            "suggest_worse_below": CALIBRATE_SUGGEST_WORSE_BELOW,
            "suggest_worse_delta": CALIBRATE_SUGGEST_WORSE_DELTA,
            "suggest_better_above": CALIBRATE_SUGGEST_BETTER_ABOVE,
            "suggest_better_delta": CALIBRATE_SUGGEST_BETTER_DELTA,
        },
        "dispatch": {
            "operator_gated": list(POLICY["dispatch"]["operator_gated"]),
            "fable_gated_efforts": list(POLICY["dispatch"]["fable_gated_efforts"]),
            "frontier_models": list(POLICY["dispatch"].get("frontier_models") or []),
            "inflight_cap": {str(k): int(v)
                             for k, v in (POLICY["dispatch"].get("inflight_cap") or {}).items()},
            "estimate_floor": {str(k): float(v)
                               for k, v in (POLICY["dispatch"].get("estimate_floor") or {}).items()},
            "extra": dict(DISPATCH_EXTRA),
        },
        "hermes": {
            "models": {k: list(v) for k, v in HERMES_MODELS.items()},
            "provider_name": dict(HERMES_PROVIDER_NAME),
        },
        "services": [svc_row(s) for s in SERVICES],
        "opencode_go": json.loads((Path(__file__).resolve().parents[1] / "config/go-model-policy.json").read_text()),
        "lead": dict(POLICY["lead"]) if POLICY.get("lead") else None,
        # Roles → concrete ids (config/model-tiers.toml); promote shifts these without a code change.
        "model_tiers": _model_tiers.public_dict(MODEL_TIERS),
    }


def policy_markdown() -> str:
    """Markdown tables: services × kinds (rank, model), gates, caps."""
    lines = ["# Routing policy", "", f"Source: `{POLICY_PATH}`", ""]
    if POLICY_PROVENANCE.get("local_config"):
        lines += [f"Local override: `{POLICY_PROVENANCE['local_config']}`", ""]
    lines += ["## Services × kinds", ""]
    header = "| service | " + " | ".join(KINDS) + " |"
    sep = "|---|" + "|".join("---" for _ in KINDS) + "|"
    lines += [header, sep]
    for s in SERVICES:
        cells = []
        for k in KINDS:
            if k not in s.good_at:
                cells.append("—")
            else:
                model = s.models.get(k, "")
                cell = f"r{s.good_at[k]}"
                if model:
                    cell += f" `{model}`"
                cells.append(cell)
        lines.append(f"| {s.name} | " + " | ".join(cells) + " |")
    lines += ["", "## Pools", "", "| service | Paseo provider (acp-dispatch agent) | billing | note |", "|---|---|---|---|"]
    for s in SERVICES:
        agent = "`cursor-cloud launch` (not a Paseo provider)" if s.acp_agent == "cursor-cloud" else (
            "none (API pool)" if s.access == "api" else s.acp_agent)
        state = " (retired)" if s.retired else ""
        lines.append(f"| {s.name}{state} | {agent} | {s.billing} | {s.note.replace('|', '/')} |")
    lines += ["", "## Gates and caps", ""]
    lines.append("| key | value |")
    lines.append("|---|---|")
    d = POLICY["dispatch"]
    lines.append(f"| routing.never_route | {', '.join(sorted(NEVER_ROUTE))} |")
    lines.append(f"| dispatch.operator_gated | {', '.join(d['operator_gated'])} |")
    lines.append(f"| dispatch.fable_gated_efforts | {', '.join(d['fable_gated_efforts'])} |")
    caps = ", ".join(f"{k}={v}" for k, v in (d.get("inflight_cap") or {}).items()) or "(none)"
    lines.append(f"| dispatch.inflight_cap | {caps} |")
    floors = ", ".join(f"{k}={v}" for k, v in (d.get("estimate_floor") or {}).items()) or "(none)"
    lines.append(f"| dispatch.estimate_floor | {floors} |")
    frontiers = ", ".join(d.get("frontier_models") or []) or "(none)"
    lines.append(f"| dispatch.frontier_models | {frontiers} |")
    fg = frontier_gate()
    lines.append(f"| gates.frontier1_per_wave / frontier2_per_wave | {fg['frontier1_per_wave']:g} / {fg['frontier2_per_wave']:g} |")
    lines.append(f"| routing.plenty_min | {PLENTY_MIN:g} |")
    lines.append(f"| gates.frontier1_min_left | {fg['frontier1_min_left']:g} |")
    lines.append(f"| gates.frontier1_window_min_left | {fg['frontier1_window_min_left']:g} |")
    lines.append(f"| gates.frontier2_min_left | {fg['frontier2_min_left']:g} |")
    lines.append(f"| routing.burn_first_min | {BURN_FIRST_MIN} |")
    lines.append(f"| routing.burn_first_waste_min | {BURN_FIRST_WASTE_MIN} |")
    lines.append(f"| routing.pace_penalty_above | {PACE_PENALTY_ABOVE} |")
    lines.append(f"| routing.pace_penalty | {PACE_PENALTY} |")
    lines.append(f"| routing.pace_penalty_judgment_factor | {PACE_PENALTY_JUDGMENT_FACTOR} |")
    lead = POLICY.get("lead")
    if lead:
        lines += ["", "## Lead / orchestrator session", "",
                  ("The session that dispatches slices runs on this; a Fable 5.2 lead is allowed "
                   "(`[lead].fable_lead = true`, operator 2026-11-07; set it to false for the 2026-10-23 "
                   "never-a-Fable-lead rule)." if LEAD_FABLE_ALLOWED else
                   "The session that dispatches slices runs on this, not on Fable "
                   "(Fable only through the `fable-deep` sub-agent or a `frontier` slice; `[lead].fable_lead` is false)."),
                  "", "| key | value |", "|---|---|"]
        lines += [f"| lead.{k} | {lead[k]} |" for k in LEAD_ALL_KEYS]
        lines.append(f"| lead.fable_lead | {'true' if LEAD_FABLE_ALLOWED else 'false'} |")
        lines += ["", (f"pipeline lead: {lead['pipeline_model']} at {lead['pipeline_effort']}; "
                       "high for judgment turns (`/effort high`, or the Paseo `--thinking` setting; "
                       "back to the pipeline effort afterwards).")]
    return "\n".join(lines) + "\n"


reload_policy()


# -- quota snapshot + service discovery ----------------------------------

def pool_service(provider: str, family: str | None) -> str | None:
    """Match an explicit quota family; never credit an unrelated provider window."""
    for svc in SERVICES:
        if svc.pool == (provider, family):
            return svc.name
    primary = next((s for s in SERVICES if s.name == provider), None)
    if primary and primary.pool_family is not None:
        if family == primary.pool_family:
            return provider
        # Claude model caps constrain the shared allowance, never add headroom.
        if provider == "claude" and family in SUBLIMIT_FAMILIES:
            return provider
        return None
    # Providers without family metadata retain their single unnamed pool. Once
    # any family is declared, a missing or unclaimed family is unknown.
    if family is None and not any(s.pool and s.pool[0] == provider for s in SERVICES):
        return provider
    return None


AIUSE_CONFIG = Path(os.environ.get("AIUSE_CONFIG", "~/.config/aiuse/config.toml")).expanduser()


def pi_block_state_path() -> Path:
    """Operational failure latches; no credentials or provider error text."""
    return Path(os.environ.get("ADE_PI_DEFAULTS_BLOCKS") or
                "~/.local/state/ade/pi-defaults/blocks.json").expanduser()


def pi_blocked_services() -> set[str]:
    pi_services = {s.name for s in SERVICES if s.acp_agent == "pi"}
    try:
        data = json.loads(pi_block_state_path().read_text())
    except FileNotFoundError:
        return set()
    except (OSError, ValueError):
        return pi_services
    if (not isinstance(data, dict) or data.get("schema_version") != 1
            or not isinstance(data.get("blocked"), dict)
            or any(not isinstance(k, str) or not isinstance(v, dict)
                   or v.get("reason") not in ("quota", "billing")
                   for k, v in data["blocked"].items())):
        return pi_services
    return set(data["blocked"])


def operator_disabled(path: Path | None = None) -> set[str]:
    """Services the operator switched off in aiuse's `[disabled_services]`.

    Routing must honour them (2026-10-12: `plan` kept offering copilot and
    cursor, both disabled there, one then reserved for grokbot). Keys are aiuse's
    canonical provider ids, the same names `Service.name` uses.
    """
    import tomllib

    try:
        with (path or AIUSE_CONFIG).open("rb") as fh:
            off = set((tomllib.load(fh).get("disabled_services") or {}).keys())
    except (OSError, tomllib.TOMLDecodeError):
        off = set()
    off |= pi_blocked_services()
    # a service that draws on a disabled provider's pool is off with it (cursor-cloud on cursor)
    return off | {s.name for s in SERVICES if s.shares_pool and s.shares_pool in off}


def _read_snapshot_file() -> tuple[list[Any], float | None]:
    """aiuse's own latest snapshot file as (accounts, age). Never probes; never blocks."""
    path = Path(os.environ.get("AIUSE_SNAPSHOT") or SNAPSHOT)
    if not path.exists():
        if os.environ.get("AIUSE_SNAPSHOT"):
            return [], None
        candidates = sorted(path.parent.glob("20*.json"), reverse=True) if path.parent.is_dir() else []
        if not candidates:
            return [], None
        path = candidates[0]
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return [], None

    collected = data.get("collected_at") or data.get("started_at") or ""
    age = None
    try:
        stamp = datetime.fromisoformat(str(collected))
        age = (datetime.now(UTC) - stamp).total_seconds()
    except (ValueError, TypeError):  # TypeError: a naive timestamp
        age = time.time() - path.stat().st_mtime

    snap = data.get("snapshot", data)
    return list(snap.get("accounts", []) or []), age


def _pct(value: Any) -> float | None:
    """A percentage clamped to [0, 100]; None for anything non-numeric or non-finite
    (NaN and Infinity must never read as headroom)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        x = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return min(100.0, max(0.0, x)) if math.isfinite(x) else None


def _clean_age(value: Any) -> float | None:
    """Seconds as a finite, non-negative float, else None (unknown)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        x = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return x if math.isfinite(x) and x >= 0 else None


def _merge_caps(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, Any]:
    """Per-key tighter of two sublimit maps (a cap never loosens by merge order)."""
    out = dict(a or {})
    for k, v in (b or {}).items():
        out[k] = _tighter(out.get(k), v) if k in out else v
    return out


def _reset_epoch(text: Any) -> float | None:
    try:
        stamp = datetime.fromisoformat(str(text))
    except (ValueError, TypeError):
        return None
    return (stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)).timestamp()


def _later_resets(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, Any]:
    """Per model sublimit the later reset wins: a reading taken before a window rolled over must not hide the new reset
    (an unreadable stamp loses to a readable one)."""
    out: dict[str, Any] = dict(a or {})
    for fam, text in (b or {}).items():
        have = _reset_epoch(out.get(fam)) if fam in out else None
        new = _reset_epoch(text)
        if fam not in out or have is None or (new is not None and new > have):
            out[fam] = text
    return out


def _merge_pool(into: dict[str, Any], key: str, entry: dict[str, Any]) -> None:
    """Fold one pool entry into `into`: the tightest known remaining wins and carries its bind."""
    prior = into.get(key)
    if prior is None:
        into[key] = entry
        return
    p_rem, e_rem = prior.get("remaining"), entry.get("remaining")
    take_new = e_rem is not None and (p_rem is None or e_rem < p_rem)
    merged = dict(entry if take_new else prior)
    merged["windows"] = _merge_caps(prior.get("windows"), entry.get("windows"))   # per window, the tighter known reading
    merged["sublimits"] = _merge_caps(prior.get("sublimits"), entry.get("sublimits"))
    resets = _later_resets(prior.get("sublimit_resets"), entry.get("sublimit_resets"))
    if resets:
        merged["sublimit_resets"] = resets      # when each model sublimit (`fable`) next resets, for the wait message
    merged["remaining"] = e_rem if take_new else p_rem
    into[key] = merged


def _tighter(a: float | None, b: float | None) -> float | None:
    vals = [v for v in (a, b) if v is not None]
    return min(vals) if vals else None


def _providers_from_available(rows: list[Any], age: float | None) -> dict[str, Any]:
    """Fold `aiuse --available --json` rows into per-service pools.

    The row's own top-level fields are the contract (`aiuse schema`): `provider`,
    `pool_family`, `usable_now`, `headroom_percent` (the least applicable headroom),
    `binding_window`, `available_at`, plus 3.8's `reading_expired` and
    `requires_operator_approval`. `windows[]` is optional detail (3.7.2 attaches it): when
    present it fills `windows`, `sublimits` and the bind fields and can only tighten the
    row's `remaining`, never loosen it. Malformed rows raise (the caller falls back)."""
    pools: dict[str, Any] = {}
    foreign: list[tuple[str, float]] = []
    for row in rows:
        name = row.get("provider")
        if not name or row.get("error"):
            continue
        family = row.get("pool_family")
        key = pool_service(name, family)
        if key is None:
            continue
        row_age = _clean_age(row.get("age_seconds"))
        if row_age is None:
            row_age = age
        stale = ((row_age is None or row_age > STALE_SOFT)
                 or row.get("reading_expired") is True)
        head = _pct(row.get("headroom_percent"))
        if ("usable_now" in row and row["usable_now"] is not True) or head == 0:
            top: float | None = 0.0
        elif stale:
            top = None
        else:
            top = None if head is None else round(head, 1)
        entry: dict[str, Any] = {
            "remaining": top, "windows": {}, "sublimits": {}, "age_s": row_age,
            "billing_kind": row.get("billing_kind"),
            "pace_ratio": None, "resets_at": row.get("available_at"), "window_minutes": None,
            "binding_window": row.get("binding_window"),
            "available_at": row.get("available_at"),
            "requires_operator_approval": row.get("requires_operator_approval"),
        }
        if row.get("binding_window"):
            entry["windows"][row["binding_window"]] = None if top is None else round(top, 1)
        folded: dict[str, Any] = {}
        if row.get("windows"):
            folded = _providers_from_accounts([row], age)
        for fkey, finfo in folded.items():
            if fkey == key:
                entry["windows"].update(finfo.get("windows") or {})
                entry["sublimits"] = _merge_caps(entry["sublimits"], finfo.get("sublimits"))
                if finfo.get("sublimit_resets"):
                    entry["sublimit_resets"] = {**(entry.get("sublimit_resets") or {}), **finfo["sublimit_resets"]}
                for k in ("pace_ratio", "resets_at", "window_minutes"):
                    if finfo.get(k) is not None:
                        entry[k] = finfo[k]
                if top is None and not stale:
                    entry["remaining"] = finfo.get("remaining")   # row gave no headroom
                elif top is not None:
                    entry["remaining"] = _tighter(top, finfo.get("remaining"))
                elif finfo.get("remaining") == 0.0:
                    entry["remaining"] = 0.0      # a stale row's exhausted window still binds
            elif finfo.get("remaining") is not None:
                # another family's window inside this row: never creates or loosens that pool
                foreign.append((fkey, finfo["remaining"]))
        if family in SUBLIMIT_FAMILIES and key == name:
            # a model cap inside the shared pool: bounds that model only (sublimits), and
            # must not drag the whole account down
            cap = _tighter(entry["remaining"], entry["sublimits"].get(family))
            entry = {**entry, "remaining": None, "windows": {},
                     "sublimits": {family: cap}}
        for cap in row.get("model_sublimits") or []:
            if name == "claude" and cap.get("pool_family") in SUBLIMIT_FAMILIES:
                value = (0.0 if cap.get("usable_now") is False
                         else _pct(cap.get("headroom_percent")))
                entry["sublimits"] = _merge_caps(
                    entry["sublimits"], {cap["pool_family"]: value})
                if cap.get("available_at"):
                    entry["sublimit_resets"] = {**(entry.get("sublimit_resets") or {}),
                                                cap["pool_family"]: cap["available_at"]}
        _merge_pool(pools, key, entry)
    for fkey, rem in foreign:
        cur = pools.get(fkey)
        if cur is not None and cur.get("remaining") is not None and rem < cur["remaining"]:
            cur["remaining"] = rem
    return pools


def _providers_from_accounts(accounts: list[Any], age: float | None) -> dict[str, Any]:
    """Fold aiuse account rows (snapshot accounts or `--available` rows) into per-service pools."""
    providers: dict[str, Any] = {}
    for acct in accounts:
        name = acct.get("provider")
        if not name or acct.get("error"):
            continue

        # Account freshness: use account's age_seconds or collected_at
        acct_age = None
        acct_age = _clean_age(acct.get("age_seconds"))
        if acct_age is None and acct.get("collected_at"):
            try:
                acct_stamp = datetime.fromisoformat(str(acct["collected_at"]))
                acct_age = (datetime.now(UTC) - acct_stamp).total_seconds()
            except (ValueError, TypeError):
                pass
        if acct_age is None:
            acct_age = age
        is_old = ((acct_age is not None and acct_age > STALE_SOFT)
                  or acct.get("reading_expired") is True)

        # One account can hold several independent model-family pools; agy's
        # Claude/GPT pool is its own service, so its windows must not drag
        # the Gemini pool's headroom down (or the reverse). Binding-window
        # pace/reset fields ride with the least-remaining window (2026-10-18).
        per_key: dict[str, tuple[Any, dict[str, float | None],
                                 dict[str, float | None], dict[str, Any]]] = {}
        sub_resets: dict[str, dict[str, Any]] = {}      # pool key -> {model sublimit family: its resets_at}
        for w in acct.get("windows") or []:
            family = w.get("pool_family")
            key = pool_service(name, family)
            if key is None:
                continue
            worst, detail, sublimits, bind = per_key.get(key, (None, {}, {}, {}))
            label = w.get("label") or "?"

            state = w.get("state")
            headroom = _pct(w.get("headroom_percent"))
            if (state == "exhausted" or (headroom is not None and headroom == 0)
                    or w.get("measurement_frozen") is True):
                # a frozen window (flat while acp-run spent the pool, aiuse "not trusted for routing") reads exhausted,
                # as aiuse's own `--available` does (2026-10-31, adversary F3)
                remaining = 0.0
            elif is_old:
                remaining = None
            else:
                # headroom_percent is the least applicable headroom (a model
                # sublimit's ceiling included); remaining_percent is the
                # window's own share. Prefer the ceiling-aware one.
                remaining = headroom if headroom is not None else _pct(w.get("remaining_percent"))

            rem_val = None if remaining is None else round(float(remaining), 1)
            detail[label] = rem_val
            is_cap = (w.get("quota_scope") == "model_sublimit"
                      and w.get("max_share_of_parent_percent") is not None)
            if (is_cap or family in SUBLIMIT_FAMILIES) and key == name:
                # A model cap inside the shared pool (Claude's `fable`, at most
                # 50% of the weekly): it bounds that model only and must not
                # drag the whole account down. Kept for the model suggestion.
                # Cursor's auto/third-party rows are breakdowns without a cap
                # and stay binding for the service that owns them.
                sublimits[family or label] = rem_val
                if w.get("resets_at"):
                    sub_resets.setdefault(key, {})[family or label] = w["resets_at"]
            elif rem_val is not None and (worst is None or rem_val < worst):
                worst = rem_val
                bind = {
                    "pace_ratio": w.get("pace_ratio"),
                    "resets_at": w.get("resets_at"),
                    "window_minutes": w.get("window_minutes"),
                }
            per_key[key] = (worst, detail, sublimits, bind)

        if not per_key:
            per_key[name] = (None, {}, {}, {})
        # Shared parent windows can tighten a matched child, never create one.
        for w in acct.get("windows") or []:
            parent = w.get("shared_pool_family")
            key = pool_service(name, w.get("pool_family"))
            if not parent or key not in per_key:
                continue
            parents = [p for p in acct.get("windows") or [] if p.get("pool_family") == parent]
            worst, detail, sublimits, bind = per_key[key]
            if not parents:
                detail[parent] = None  # declared parent is required, never inferred
            for pw in parents:
                rem = _pct(pw.get("headroom_percent"))
                if rem is None:
                    rem = _pct(pw.get("remaining_percent"))
                if pw.get("state") == "exhausted" or pw.get("measurement_frozen") is True:
                    rem = 0.0
                elif is_old:
                    rem = None
                detail[pw.get("label") or parent] = rem
                if rem is not None:
                    worst = _tighter(worst, rem)
            per_key[key] = (worst, detail, sublimits, bind)
        for key, (worst, detail, sublimits, bind) in per_key.items():
            prior = providers.get(key) or {}
            prior_rem = prior.get("remaining")
            if prior_rem is not None and worst is not None:
                if prior_rem < worst:
                    # several accounts: the tightest wins, keep its bind fields
                    worst = prior_rem
                    bind = {k: prior.get(k) for k in ("pace_ratio", "resets_at",
                                                      "window_minutes")}
                # else keep this account's bind (already set for `worst`)
            elif prior_rem is not None and worst is None:
                worst = prior_rem
                bind = {k: prior.get(k) for k in ("pace_ratio", "resets_at",
                                                  "window_minutes")}
            providers[key] = {
                "remaining": None if worst is None else round(float(worst), 1),
                "windows": detail, "sublimits": sublimits, "age_s": acct_age,
                "billing_kind": acct.get("billing_kind"),
                "pace_ratio": bind.get("pace_ratio"),
                "resets_at": bind.get("resets_at"),
                "window_minutes": bind.get("window_minutes"),
            }
            if sub_resets.get(key):
                providers[key]["sublimit_resets"] = dict(sub_resets[key])
    return providers


class QuotaSource:
    """Where the last load_snapshot() got its pool state (surfaced by plan/show/route)."""
    kind = "snapshot"          # "aiuse" | "canned" | "snapshot" | "paseo" (Paseo usage alone)
    detail = ""
    fallback_reason = ""
    paseo = ""                 # "paseo usage ls --json" (or the canned path) when it was read, else why not
    pools: ClassVar[dict[str, str]] = {}  # service -> "aiuse" | "canned" | "snapshot" | "paseo" | "<aiuse source>+paseo"


def _log(msg: str) -> None:
    print(f"route_agent: {msg}", file=sys.stderr)


def _aiuse_wanted() -> bool:
    """Ask aiuse itself, not the snapshot file, unless something pins the file.

    AIUSE_SNAPSHOT (tests, a replayed snapshot), a patched SNAPSHOT, or
    ROUTE_AGENT_AIUSE=off keep the old file-only read (ROUTE_AGENT_AIUSE_JSON, canned
    output, overrides all three; load_snapshot checks it first)."""
    if os.environ.get("ROUTE_AGENT_AIUSE", "").strip().lower() in ("off", "0", "no", "false"):
        return False
    return not (os.environ.get("AIUSE_SNAPSHOT") or SNAPSHOT != DEFAULT_SNAPSHOT)


AIUSE_MEMO_TTL = 30.0   # seconds a spawn result is reused (a blocking dispatch re-reads at finalize)
_AIUSE_MEMO: dict[tuple[Any, ...], tuple[float, tuple[dict[str, Any] | None, str]]] = {}


def _aged_copy(result: tuple[dict[str, Any] | None, str],
               elapsed: float) -> tuple[dict[str, Any] | None, str]:
    """A memoised result as it reads now: deep copy with `elapsed` added to every age_seconds
    (top level and per row), so staleness keeps advancing. Never mutates the cached object."""
    import copy
    payload, label = result
    if payload is None:
        return result
    out = copy.deepcopy(payload)
    holders = [out] + [row for row in out.get("available", []) if isinstance(row, dict)]
    for holder in holders:
        age = _clean_age(holder.get("age_seconds"))
        if age is not None:
            holder["age_seconds"] = age + elapsed
    return out, label


def _reset_aiuse_cache() -> None:
    """Forget memoised `aiuse --available --json` results (tests; one spawn per process otherwise)."""
    _AIUSE_MEMO.clear()


def _aiuse_timeout() -> float:
    try:
        t = float(os.environ.get("ROUTE_AGENT_AIUSE_TIMEOUT") or 20)
    except ValueError:
        return 20.0
    return t if math.isfinite(t) and 0 < t <= 60 else 20.0


def _parse_available(raw: bytes, label: str) -> tuple[dict[str, Any] | None, str]:
    try:
        text = raw.decode("utf-8")        # strict: invalid bytes are malformed output
        # --json can follow preamble lines on some builds: start at the first brace
        payload = json.loads(text[text.index("{"):])
    except ValueError:                    # includes UnicodeDecodeError and a missing brace
        return None, f"{label}: malformed JSON"
    if not isinstance(payload, dict) or not isinstance(payload.get("available"), list):
        return None, f"{label}: no `available` array"
    return payload, label


def aiuse_available(bypass_memo: bool = False) -> tuple[dict[str, Any] | None, str]:
    """`aiuse --available --json` as (payload, source label); (None, reason) on any failure.

    Applies aiuse's own read-time overlays (operator credits override, Admin API readings,
    grant expiry) that the snapshot file never carries (2026-10-20, aiuse PRs 38 and 40).
    ROUTE_AGENT_AIUSE_JSON=<path> reads canned output instead (tests) and takes precedence
    over ROUTE_AGENT_AIUSE=off and AIUSE_SNAPSHOT; ROUTE_AGENT_AIUSE_BIN names the binary;
    ROUTE_AGENT_AIUSE_TIMEOUT is in seconds, (0, 60], default 20 (the cache read is well
    under one second). Exit 3 means nothing is usable and still prints the JSON. The
    subprocess result (success or failure) is memoised for AIUSE_MEMO_TTL = 30 s, with elapsed
    seconds added to its ages on reuse (`_reset_aiuse_cache` clears it). `bypass_memo=True` skips the
    memo read and spawns anyway (still storing the result): the admission boundaries that judge a
    reading after a wait pass it (2026-10-25, Codex review of PR 73); every other caller keeps the memo."""
    canned = os.environ.get("ROUTE_AGENT_AIUSE_JSON")
    if canned:
        try:
            raw = Path(canned).read_bytes()
        except OSError as exc:
            return None, f"ROUTE_AGENT_AIUSE_JSON unreadable ({exc.__class__.__name__})"
        return _parse_available(raw, f"ROUTE_AGENT_AIUSE_JSON={canned}")
    exe = os.environ.get("ROUTE_AGENT_AIUSE_BIN") or shutil.which("aiuse")
    if not exe:
        return None, "aiuse not on PATH"
    timeout = _aiuse_timeout()
    key = (exe, timeout)
    hit = None if bypass_memo else _AIUSE_MEMO.get(key)
    if hit is not None:
        elapsed = time.monotonic() - hit[0]
        if 0 <= elapsed < AIUSE_MEMO_TTL:
            return _aged_copy(hit[1], elapsed)
    label = "aiuse --available --json"
    try:
        proc = subprocess.run([exe, "--available", "--json"], capture_output=True,
                              timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        result: tuple[dict[str, Any] | None, str] = (
            None, f"{label} timed out after {timeout:g}s")
    except OSError as exc:
        result = (None, f"aiuse could not start ({exc.__class__.__name__})")
    else:
        if proc.returncode not in (0, 3):
            result = (None, f"{label} exited {proc.returncode}")
        else:
            result = _parse_available(proc.stdout, label)
    _AIUSE_MEMO[key] = (time.monotonic(), result)
    return result


def _payload_age(payload: dict[str, Any]) -> float | None:
    age = _clean_age(payload.get("age_seconds"))
    if age is not None:
        return age
    try:
        return _clean_age((datetime.now(UTC) - datetime.fromisoformat(
            str(payload.get("generated_at")))).total_seconds())
    except (ValueError, TypeError):
        return None


def quota_source_info() -> dict[str, Any]:
    """Where the last load_snapshot() read pool state, for plan/show/route output."""
    return {"source": QuotaSource.kind, "detail": QuotaSource.detail,
            "fallback_reason": QuotaSource.fallback_reason or None,
            "paseo": QuotaSource.paseo or None, "pools": dict(QuotaSource.pools)}


# -- Paseo: the provider registry and `paseo usage ls` (slim-down E7, 2026-11-07) ------------------------

PASEO_MEMO_TTL = 30.0          # seconds a `paseo usage ls` result is reused, like the aiuse spawn
PASEO_LOADING_RETRIES = 2      # `provider ls` rows still `loading`: re-read this many times ...
PASEO_LOADING_WAIT = 3.0       # ... this many seconds apart (6 s in all), then absent
_PASEO_USAGE_MEMO: dict[tuple[Any, ...], tuple[float, tuple[list[Any] | None, str]]] = {}
_PROVIDER_MODELS: dict[str, list[str] | None] = {}
_PROVIDER_ROWS: list[list[dict[str, Any]]] = []       # one `provider ls` result per process (empty: not read yet)


def _paseo_wanted() -> bool:
    return os.environ.get("ROUTE_AGENT_PASEO", "").strip().lower() not in ("off", "0", "no", "false")


def _paseo_timeout() -> float:
    try:
        t = float(os.environ.get("ROUTE_AGENT_PASEO_TIMEOUT") or 15)
    except ValueError:
        return 15.0
    return t if math.isfinite(t) and 0 < t <= 60 else 15.0


def _reset_paseo_cache() -> None:
    """Forget memoised Paseo reads (tests; each process reads at most once per TTL otherwise)."""
    _PASEO_USAGE_MEMO.clear()
    _PROVIDER_MODELS.clear()
    _PROVIDER_ROWS.clear()


def _paseo_json(args: list[str]) -> tuple[Any, str]:
    """`paseo ARGS --json` parsed, or (None, why). Never raises; bounded by ROUTE_AGENT_PASEO_TIMEOUT (default 15 s)."""
    label = "paseo " + " ".join(args) + " --json"
    if not _paseo_wanted():
        return None, "ROUTE_AGENT_PASEO=off"
    exe = os.environ.get("ROUTE_AGENT_PASEO_BIN") or shutil.which("paseo")
    if not exe:
        return None, "paseo not on PATH"
    timeout = _paseo_timeout()
    try:
        proc = subprocess.run([exe, *args, "--json"], capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return None, f"{label} timed out after {timeout:g}s"
    except OSError as exc:
        return None, f"paseo could not start ({exc.__class__.__name__})"
    if proc.returncode != 0:
        return None, f"{label} exited {proc.returncode}"
    try:
        return json.loads(proc.stdout.decode("utf-8")), label
    except ValueError:
        return None, f"{label}: malformed JSON"


def paseo_provider_rows() -> list[dict[str, Any]]:
    """`paseo provider ls --json` rows ([] when Paseo cannot be read), read once per process (`_reset_paseo_cache` forgets
    it). A row whose `status` is still `loading` (the daemon just started) is re-read PASEO_LOADING_RETRIES times,
    PASEO_LOADING_WAIT seconds apart; a row loading after that is dropped with a note on stderr (absent, never available)."""
    if not _PROVIDER_ROWS:
        _PROVIDER_ROWS.append(_read_provider_rows())
    return list(_PROVIDER_ROWS[0])


def _read_provider_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for attempt in range(PASEO_LOADING_RETRIES + 1):
        data, why = _paseo_json(["provider", "ls"])
        if not isinstance(data, list):
            if data is not None:
                _log(f"{why}: not a JSON array; no Paseo providers")
            return []
        rows = [r for r in data if isinstance(r, dict) and isinstance(r.get("provider"), str) and r["provider"]]
        if not any(r.get("status") == "loading" for r in rows) or attempt == PASEO_LOADING_RETRIES:
            break
        time.sleep(PASEO_LOADING_WAIT)
    loading = sorted(r["provider"] for r in rows if r.get("status") == "loading")
    if loading:
        _log(f"paseo provider ls: still loading after {PASEO_LOADING_RETRIES * PASEO_LOADING_WAIT:g}s, "
             f"treated as absent: {', '.join(loading)}")
    return [r for r in rows if r.get("status") != "loading"]


def paseo_providers() -> set[str]:
    """The Paseo providers this machine can dispatch to now: enabled ("Enabled") and `available`."""
    return {r["provider"] for r in paseo_provider_rows()
            if r.get("enabled") == "Enabled" and r.get("status") == "available"}


def _pi_agent_dir() -> Path:
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent")


def pi_refreshed_namespaces() -> set[str]:
    """Provider namespaces Pi keeps a refreshed catalog for: the top-level keys of Pi's `models-store.json`
    (`pi update models` and Pi's print-mode start refresh it). Empty when the file cannot be read."""
    try:
        data = json.loads((_pi_agent_dir() / "models-store.json").read_text())
    except (OSError, ValueError):
        return set()
    return {str(k) for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else set()


def pi_catalog_models() -> list[str] | None:
    """`provider/id` of every model `pi --list-models` shows (Pi's own current catalog, authenticated providers only),
    or None when Pi cannot say. ROUTE_AGENT_PASEO=off disables it with the Paseo reads; ROUTE_AGENT_PI_BIN names the binary."""
    if not _paseo_wanted():
        return None
    exe = os.environ.get("ROUTE_AGENT_PI_BIN") or shutil.which("pi")
    if not exe:
        return None
    try:
        # A neutral cwd: Pi loads project-local config and extensions from the directory it starts in.
        proc = subprocess.run([exe, "--list-models"], capture_output=True, text=True, timeout=_paseo_timeout(),
                              stdin=subprocess.DEVNULL, check=False, cwd=os.path.expanduser("~"))
    except (subprocess.TimeoutExpired, OSError):
        return None
    rows = [ln.split() for ln in proc.stdout.splitlines()]
    if proc.returncode != 0 or not rows or rows[0][:2] != ["provider", "model"]:
        return None
    return [f"{r[0]}/{r[1]}" for r in rows[1:] if len(r) >= 2]


def _pi_models(paseo_ids: list[str] | None) -> list[str] | None:
    """Paseo's Pi model list corrected by Pi's own catalog (2026-11-10: Paseo kept listing antigravity/gemini-3.1-pro, gone
    from Pi's catalog, and omitted antigravity/gemini-4-argon, which Pi runs). Where Pi keeps a refreshed catalog for a
    namespace (a `models-store.json` key: antigravity, openai, ...), `pi --list-models` replaces Paseo's entries for it; a
    namespace the extensions supply live (cursor: Paseo lists ~260 while Pi's static list has 15) stays as Paseo lists it.
    Pi unreadable: Paseo's list unchanged. Paseo unreadable: Pi's own list."""
    pi_ids = pi_catalog_models()
    if pi_ids is None:
        return paseo_ids
    if paseo_ids is None:
        return pi_ids                       # Paseo cannot say: Pi's static list (no live cursor models) beats nothing
    refreshed = pi_refreshed_namespaces()
    return ([m for m in paseo_ids if m.partition("/")[0] not in refreshed]
            + [m for m in pi_ids if m.partition("/")[0] in refreshed])


def provider_models(provider: str) -> list[str] | None:
    """Model ids `paseo provider models <provider> --json` lists, or None when Paseo cannot say. Cached per process.
    The Pi provider's list is corrected by Pi's own catalog (`_pi_models`): Paseo's copy goes stale."""
    if provider not in _PROVIDER_MODELS:
        data, _ = _paseo_json(["provider", "models", provider])
        ids = None
        if isinstance(data, list):
            ids = [str(m.get("id") or m.get("model")) for m in data
                   if isinstance(m, dict) and (m.get("id") or m.get("model"))]
        _PROVIDER_MODELS[provider] = _pi_models(ids) if provider == "pi" else ids
    return _PROVIDER_MODELS[provider]


def paseo_usage(bypass_memo: bool = False) -> tuple[list[Any] | None, str]:
    """`paseo usage ls --json` as (rows, source label); (None, why) on any failure. ROUTE_AGENT_PASEO_USAGE_JSON=<path> reads
    canned output instead (tests; it wins over ROUTE_AGENT_PASEO=off). Memoised for PASEO_MEMO_TTL; `bypass_memo` skips it."""
    canned = os.environ.get("ROUTE_AGENT_PASEO_USAGE_JSON")
    if canned:
        try:
            data = json.loads(Path(canned).read_text())
        except (OSError, ValueError) as exc:
            return None, f"ROUTE_AGENT_PASEO_USAGE_JSON unreadable ({exc.__class__.__name__})"
        return (data, f"ROUTE_AGENT_PASEO_USAGE_JSON={canned}") if isinstance(data, list) else (
            None, "ROUTE_AGENT_PASEO_USAGE_JSON: not a JSON array")
    key = (os.environ.get("ROUTE_AGENT_PASEO_BIN") or shutil.which("paseo"), _paseo_timeout(), _paseo_wanted())
    hit = None if bypass_memo else _PASEO_USAGE_MEMO.get(key)
    if hit is not None and 0 <= time.monotonic() - hit[0] < PASEO_MEMO_TTL:
        return hit[1]
    data, why = _paseo_json(["usage", "ls"])
    result: tuple[list[Any] | None, str] = (data, why) if isinstance(data, list) else (
        None, why if data is None else f"{why}: not a JSON array")
    _PASEO_USAGE_MEMO[key] = (time.monotonic(), result)
    return result


# Paseo usage `sourceId` -> routing service, where the two names differ (opencode's Paseo source is the Go pool).
PASEO_USAGE_SERVICE = {"opencode": "opencode-go"}


def _usage_service(source: str) -> str:
    base = source.split(":", 1)[0]
    return PASEO_USAGE_SERVICE.get(base) or ALIASES.get(base, base)


def usage_from_paseo(rows: list[Any], now: datetime | None = None) -> dict[str, Any]:
    """Fold `paseo usage ls --json` rows into per-service pools, keyed by each row's `sourceId`.

    A report whose `status` is `available` gives `windows` ({label: percent left}, from `remainingPct`, else
    100 - `usedPct`), `balances` (percent of `limit` left, labelled by unit), `remaining` (the tightest), and the
    binding window's `resetsAt`; a window naming a SUBLIMIT_FAMILIES model (Claude's Fable) is a cap of that model, not
    a window of the pool. A report older than STALE_SOFT (`fetchedAt`) keeps only an exhausted window. Any other status,
    or a row without a report, is UNKNOWN: `remaining` None and `unknown` saying why, never a pass. `icon` (inline SVG)
    and `loginErrors` are dropped."""
    now = now or datetime.now(UTC)
    out: dict[str, Any] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        source = row.get("sourceId") or row.get("id")
        if not isinstance(source, str) or not source:
            continue
        key = _usage_service(source)
        # Paseo's native Claude report is the subscription's default pool and
        # currently omits family metadata (verified 2026-11-12). Normalize only
        # that source; other providers and explicit families stay fail-closed.
        family = row.get("pool_family")
        if key == "claude" and family is None:
            family = "default"
        scoped = any((svc.name == key and svc.pool_family)
                     or (svc.pool and svc.pool[0] == key) for svc in SERVICES)
        if scoped:
            if family in SUBLIMIT_FAMILIES:
                continue  # a standalone model cap cannot fund shared quota
            key = pool_service(key, family)
            if key is None:
                continue
        report = row.get("report") if isinstance(row.get("report"), dict) else {}
        try:
            fetched = datetime.fromisoformat(str(row.get("fetchedAt")).replace("Z", "+00:00"))  # noqa: FURB162  (keeps the exact Z handling for malformed input)
            fetched = fetched if fetched.tzinfo else fetched.replace(tzinfo=UTC)
            age = _clean_age((now - fetched).total_seconds())
        except (ValueError, TypeError):
            age = None
        status = report.get("status")
        entry: dict[str, Any] = {"remaining": None, "windows": {}, "sublimits": {}, "pace_ratio": None,
                                 "resets_at": None, "window_minutes": None, "age_s": age, "source": "paseo",
                                 "plan": report.get("planLabel")}
        if status != "available":
            problem = report.get("problem") if isinstance(report.get("problem"), dict) else {}
            entry["unknown"] = (f"paseo usage {source}: report {status or 'missing'}"
                                + (f" ({problem.get('kind')})" if problem.get("kind") else ""))
            prior = out.get(key)
            if prior is None:
                out[key] = entry
            continue
        windows, balances = report.get("windows") or [], report.get("balances") or []
        if not isinstance(windows, list) or not isinstance(balances, list):
            # a malformed report measures nothing: this pool reads as Paseo "not read", never a pass
            entry["unknown"] = f"paseo usage {source}: not read (windows or balances is not a list)"
            if out.get(key) is None:
                out[key] = entry
            continue
        stale = age is None or age > STALE_SOFT
        worst: float | None = None
        for i, w in enumerate(windows):
            if not isinstance(w, dict):
                continue
            label = str(w.get("label") or w.get("id") or f"window {i + 1}")
            rem = _pct(w.get("remainingPct"))
            if rem is None and _pct(w.get("usedPct")) is not None:
                rem = 100.0 - _pct(w.get("usedPct"))
            if rem is not None and stale and rem > 0:
                rem = None                          # a stale report measures nothing but an exhausted window
            rem = None if rem is None else round(rem, 1)
            family = next((f for f in SUBLIMIT_FAMILIES if f in label.lower()), None)
            if family:
                entry["sublimits"][family] = _tighter(entry["sublimits"].get(family), rem)
                if w.get("resetsAt"):
                    entry.setdefault("sublimit_resets", {})[family] = w["resetsAt"]
                continue
            entry["windows"][label] = rem
            if rem is not None and (worst is None or rem < worst):
                worst, entry["resets_at"] = rem, w.get("resetsAt")
        for b in balances:
            if not isinstance(b, dict):
                continue
            try:
                left, limit = float(b.get("remaining")), float(b.get("limit"))
            except (TypeError, ValueError):
                continue
            if not (math.isfinite(left) and math.isfinite(limit)) or limit <= 0:
                continue
            rem = _pct(100.0 * left / limit)
            if rem is not None and stale and rem > 0:
                rem = None
            label = f"{b.get('unit') or 'balance'} balance"
            entry["windows"][label] = None if rem is None else round(rem, 1)
            if rem is not None and (worst is None or rem < worst):
                worst, entry["resets_at"] = rem, b.get("resetsAt")
        entry["remaining"] = None if worst is None else round(worst, 1)
        prior = out.get(key)
        if prior is not None and prior.get("unknown"):
            out[key] = entry                        # one available report of a source beats an unknown one
        else:
            _merge_pool(out, key, entry)
    return out


def _fold_paseo(providers: dict[str, Any], paseo: dict[str, Any]) -> None:
    """Merge Paseo's pools into the aiuse reading in place (`_merge_pool`: the tightest known reading wins). An unknown
    Paseo report never loosens or replaces a reading: it is recorded as `paseo_unknown` beside it, or stands alone (as
    unknown) for a pool aiuse does not know."""
    for key, entry in paseo.items():
        prior = providers.get(key)
        if entry.get("remaining") is None and not entry.get("sublimits"):
            if prior is None:
                providers[key] = entry
                QuotaSource.pools[key] = "paseo"
            else:
                prior["paseo_unknown"] = entry.get("unknown") or "paseo usage: no window reading"
            continue
        if prior is None or prior.get("unknown"):
            providers[key] = {k: v for k, v in entry.items() if k != "unknown"}
            QuotaSource.pools[key] = "paseo"
            continue
        _merge_pool(providers, key, entry)
        QuotaSource.pools[key] = f"{QuotaSource.pools.get(key) or QuotaSource.kind}+paseo"


def _apply_excluded(providers: dict[str, Any], excluded: Any) -> None:
    """Pools the operator ruled out (`excluded[]`) read 0% left, even with no snapshot row.

    Same conditions as the absent-pool rule (the caller applies it only for a valid, fresh
    payload), and the merge only tightens. An invalid excluded row is ignored rather than a
    fallback trigger: `excluded` is advisory, and one bad entry must not discard a good
    `available` list. An excluded sublimit family (`fable`) caps that model only."""
    if not isinstance(excluded, list):
        return
    for row in excluded:
        if not (isinstance(row, dict) and isinstance(row.get("provider"), str)
                and row["provider"] and isinstance(row.get("pool_family"), (str, type(None)))):
            continue
        name, family = row["provider"], row.get("pool_family")
        key = pool_service(name, family)
        if key is None:
            continue
        prior = providers.get(key) or {"windows": {}, "sublimits": {}, "remaining": None}
        entry = dict(prior, excluded=True, reason=row.get("reason"))
        if family in SUBLIMIT_FAMILIES and key == name:
            entry["sublimits"] = _merge_caps(prior.get("sublimits"), {family: 0.0})
        else:
            entry["remaining"] = _tighter(prior.get("remaining"), 0.0)
        providers[key] = entry


def _stale_pool_keys(payload: dict[str, Any], p_age: float | None) -> set[tuple[str, Any]] | None:
    """The (provider, pool_family) rows a `fresh: false` payload blames, or None when it blames nothing usable.

    aiuse's top-level `fresh` is false when ANY usable entry is past its own pool's fresh limit (antigravity
    ships at 600 s and is queried at most every 15 min, so it is stale a third of the time); `stale_pools`
    names those entries (`aiuse schema`, schema 1.5), a subset of `available`. Only a literal `fresh: false`,
    a non-empty list of well-formed entries (`provider` str, the `pool_family` key present as str or null),
    every one naming a (provider, pool_family) that some `available` row carries, and a snapshot whose own age
    is known and within STALE_SOFT, read per pool: just those rows are stale. Anything else fails closed to a
    whole-payload stale read: a non-False `fresh`, no list or an empty one, a malformed entry, a missing or
    misspelled family (an entry that matches no row would mark nothing and leave the stale row reading fresh),
    or an unknown or old snapshot age. Matching ignores `account`, so a stale entry can only over-mark.
    2026-11-13: one stale antigravity pool made `plan` refuse every pool."""
    stale, avail = payload.get("stale_pools"), payload.get("available")
    if (payload.get("fresh") is not False or not isinstance(stale, list) or not stale
            or not isinstance(avail, list) or p_age is None or p_age > STALE_SOFT
            or not all(isinstance(e, dict) and isinstance(e.get("provider"), str) and e["provider"]
                       and "pool_family" in e and isinstance(e["pool_family"], (str, type(None)))
                       for e in stale)):
        return None
    keys = {(e["provider"], e["pool_family"]) for e in stale}
    if not all(isinstance(row, dict) and isinstance(row.get("provider"), str)
               and isinstance(row.get("pool_family"), (str, type(None))) for row in avail):
        return None                      # an invalid row: load_snapshot's own "invalid row" fallback decides
    rows = {(row["provider"], row.get("pool_family")) for row in avail}
    return keys if keys <= rows else None


def load_snapshot(bypass_memo: bool = False) -> tuple[dict[str, Any], float | None]:
    """Pool state per service: `aiuse --available --json`, else the snapshot file.

    Never probes live (the `--available` form reads aiuse's cache, well under a second).
    `--available` lists only usable pools, so a pool the snapshot file knows that is
    missing from a fresh payload is exhausted, excluded or hidden: it reads 0% left rather
    than unknown. Fields 3.8 adds (`expires_at`, `burn_before_reset`, `reading_expired`,
    `source`) are tolerated when absent; the row's own `resets_at` and windows carry them.
    `bypass_memo=True` makes the aiuse read skip its 30 s memo (see aiuse_available)."""
    QuotaSource.kind, QuotaSource.detail, QuotaSource.fallback_reason = "snapshot", "", ""
    QuotaSource.paseo, QuotaSource.pools = "", {}
    accounts, age = _read_snapshot_file()
    providers = _providers_from_accounts(accounts, age)
    canned = bool(os.environ.get("ROUTE_AGENT_AIUSE_JSON"))
    if canned or _aiuse_wanted():
        payload, label = aiuse_available(bypass_memo)
        fresh: dict[str, Any] | None = None
        p_age: float | None = None
        marked_stale = False
        if payload is not None:
            p_age = _payload_age(payload)
            # the contract's own staleness signal: `fresh` present and not True means stale
            marked_stale = payload.get("fresh") is not None and payload.get("fresh") is not True
            stale_keys: set[tuple[str, Any]] = set()
            if marked_stale:
                blamed = _stale_pool_keys(payload, p_age)
                if blamed is not None:
                    # `stale_pools` names the rows: only those read as stale, the rest use their own age
                    stale_keys, marked_stale = blamed, False
                    label = (f"{label} (payload fresh={payload.get('fresh')!r}: stale_pools names "
                             + ", ".join(sorted(f"{p}/{f}" if f else p for p, f in blamed))
                             + "; those pools read unknown)")
                else:
                    label = f"{label} (payload fresh={payload.get('fresh')!r}: read as stale)"
                    if p_age is None or p_age <= STALE_SOFT:
                        p_age = STALE_SOFT + 1
            if not all(isinstance(row, dict) and isinstance(row.get("provider"), str)
                       and row["provider"] and isinstance(row.get("pool_family"), (str, type(None)))
                       for row in payload["available"]):
                label = f"{label}: invalid row"
            else:
                try:
                    # a row without a usable age is stale, never fresh
                    rows = [dict(row, age_seconds=(
                        STALE_HARD + 1 if marked_stale
                        or (row.get("provider"), row.get("pool_family")) in stale_keys
                        else _clean_age(row.get("age_seconds"))
                        if _clean_age(row.get("age_seconds")) is not None
                        else (p_age if p_age is not None and not stale_keys else STALE_HARD + 1)))
                        for row in payload["available"]]
                    fresh = _providers_from_available(rows, p_age)
                except (ValueError, TypeError, AttributeError, OverflowError):
                    label = f"{label}: unparseable rows"
        if canned:
            _log(f"quota from canned ROUTE_AGENT_AIUSE_JSON={os.environ['ROUTE_AGENT_AIUSE_JSON']}"
                 " (overrides ROUTE_AGENT_AIUSE=off and AIUSE_SNAPSHOT)")
        if fresh is None:
            QuotaSource.fallback_reason = label
            _log(f"{label}; using the snapshot file {SNAPSHOT}")
        else:
            QuotaSource.kind = "canned" if canned else "aiuse"
            QuotaSource.detail = label
            if p_age is not None and p_age <= STALE_SOFT:
                for key, info in providers.items():
                    if key not in fresh:
                        providers[key] = dict(info, remaining=0.0,
                                              absent_from_available=True)
            providers.update(fresh)
            if p_age is not None and p_age <= STALE_SOFT:
                _apply_excluded(providers, payload.get("excluded"))
            age = p_age if p_age is not None else age
    else:
        QuotaSource.detail = str(os.environ.get("AIUSE_SNAPSHOT") or SNAPSHOT)
    if age is not None and age > STALE_HARD:
        providers = {}                      # a dead collector: aiuse measures nothing (Paseo may still)
    QuotaSource.pools = {k: QuotaSource.kind for k in providers}
    rows, plabel = paseo_usage(bypass_memo)
    if rows is None:
        QuotaSource.paseo = f"not read: {plabel}"
    else:
        QuotaSource.paseo = plabel
        try:
            paseo = usage_from_paseo(rows)
        except (TypeError, ValueError, AttributeError, OverflowError) as exc:   # belt and braces: the usage path never raises
            QuotaSource.paseo, paseo = f"not read: {plabel}: unparseable ({exc.__class__.__name__})", {}
        if paseo and not providers:
            ages = [a for a in (e.get("age_s") for e in paseo.values() if e.get("remaining") is not None)
                    if a is not None]
            if ages:
                QuotaSource.kind, age = "paseo", max(ages)
        _fold_paseo(providers, paseo)
    for svc in SERVICES:
        if svc.shares_pool and svc.name not in providers and svc.shares_pool in providers:
            providers[svc.name] = dict(providers[svc.shares_pool])
            QuotaSource.pools[svc.name] = QuotaSource.pools.get(svc.shares_pool, QuotaSource.kind)
    return providers, age


def claude_quota_state(now: datetime | None = None) -> dict[str, Any]:
    """The Claude pool's reading for the frontier allowance (ade_gates.read_guard_state, judged_guard_block): the merged
    snapshot's `claude` entry as {checked_at, source, remaining (the tightest window), fable_left (the Fable sublimit),
    windows, unknown}. `checked_at` is now minus that pool's own reading age (else the snapshot's age); `unknown` says why
    there is no reading (nothing reports claude, or only a Paseo report that is not `available`): the gate fails closed on
    it, on a reading older than 30 minutes and on a missing window percentage."""
    now = now or datetime.now(UTC)
    saved = (QuotaSource.kind, QuotaSource.detail, QuotaSource.fallback_reason, QuotaSource.paseo, QuotaSource.pools)
    try:
        quota, age = load_snapshot()
        source, fallback = QuotaSource.pools.get("claude"), QuotaSource.fallback_reason
    finally:        # a caller's quota_source_info() describes its own load, not this one
        (QuotaSource.kind, QuotaSource.detail, QuotaSource.fallback_reason, QuotaSource.paseo,
         QuotaSource.pools) = saved
    info = quota.get("claude")
    if not isinstance(info, dict):
        return {"checked_at": None, "source": None, "remaining": None, "fable_left": None, "windows": {},
                "unknown": "no Claude reading from aiuse or paseo usage" + (f" ({fallback})" if fallback else "")}
    pool_age = _clean_age(info.get("age_s"))
    pool_age = pool_age if pool_age is not None else age
    checked = None if pool_age is None else ade_gates.iso(now - timedelta(seconds=pool_age))
    return {"checked_at": checked, "source": source, "remaining": info.get("remaining"),
            "fable_left": (info.get("sublimits") or {}).get("fable"), "windows": dict(info.get("windows") or {}),
            "unknown": info.get("unknown"), "paseo_unknown": info.get("paseo_unknown")}


def hours_to_reset(resets_at: Any, *, now: datetime | None = None) -> float | None:
    """Hours until `resets_at` (ISO), or None when unparseable.

    A reset already in the past returns 0.0 (not None), so expected waste
    equals remaining — the window has refilled.
    """
    if not resets_at:
        return None
    try:
        stamp = datetime.fromisoformat(str(resets_at).replace("Z", "+00:00"))  # noqa: FURB162  (keeps the exact Z handling for malformed input)
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=UTC)
        now = now or datetime.now(UTC)
        return max(0.0, (stamp - now).total_seconds() / 3600.0)
    except (ValueError, TypeError):
        return None


def expected_waste(remaining: float | None, pace_ratio: Any,
                   resets_at: Any, window_minutes: Any,
                   *, now: datetime | None = None) -> float | None:
    """Unused share of the binding window at reset if current pace holds.

    projected_use ≈ pace × (100 / W_hours) × t_hours; waste = max(0, r − that).
    Missing pace_ratio assumes p = 1. Missing resets_at or window_minutes →
    unknown (None). Operator /steps 1.6, 2026-10-18.
    """
    if remaining is None or resets_at is None or window_minutes is None:
        return None
    try:
        w_hours = float(window_minutes) / 60.0
        if w_hours <= 0:
            return None
        t = hours_to_reset(resets_at, now=now)
        if t is None:
            return None
        p = 1.0 if pace_ratio is None else float(pace_ratio)
        projected = p * (100.0 / w_hours) * t
        return max(0.0, float(remaining) - projected)
    except (ValueError, TypeError):
        return None


def grant_waste(remaining: float | None, resets_at: Any, grant_days: int,
                *, now: datetime | None = None) -> float | None:
    """Percent points of an expiring grant held above an even spend over its period.

    omp's Claude API credits (operator 2026-10-19: spend them before each monthly reset)
    have an expiry and no window or pace, so expected_waste() returns None for them. An
    even spend leaves 100 x (hours left / period hours) percent; anything above that is
    ahead of schedule and, at the reset, wasted if nothing burns it. Unknown balance or
    expiry, or no grant period, gives None.
    """
    if remaining is None or not grant_days or grant_days <= 0:
        return None
    t = hours_to_reset(resets_at, now=now)
    if t is None:
        return None
    fair_left = 100.0 * min(1.0, t / (grant_days * 24.0))
    return max(0.0, float(remaining) - fair_left)


def omp_anthropic_ready() -> bool:
    """True when omp holds an enabled Anthropic credential (the Claude API credits path).

    omp's agent.db keeps one row per login; a refresh failure sets `disabled_cause` and the
    login needs `omp login` again (2026-10-19: the Anthropic OAuth refresh token had expired
    on 2026-10-13, so every `omp --model anthropic/...` run ended "No API key found for
    anthropic"). Reads only provider and disabled_cause, never the credential. Env
    ROUTE_AGENT_OMP_READY=1/0 forces the answer (tests, a deliberate override)."""
    forced = os.environ.get("ROUTE_AGENT_OMP_READY", "").strip().lower()
    if forced:
        return forced in ("1", "true", "yes")
    base = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp" / "agent")
    db = base / "agent.db"
    if not db.is_file():
        return False
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute("select count(*) from auth_credentials where "
                              "provider = 'anthropic' and disabled_cause is null").fetchone()
        finally:
            con.close()
        return bool(row and row[0])
    except Exception:  # noqa: BLE001 - an unreadable db means not ready
        return False


READY_PROBES = {"omp-anthropic": omp_anthropic_ready,
                "pi": lambda: "pi" in paseo_providers()}


def service_ready(svc: Service) -> bool:
    """False when the service names a readiness probe that fails now."""
    probe = READY_PROBES.get(svc.ready_probe) if svc.ready_probe else None
    return True if probe is None else bool(probe())


# DEFAULT_PROFILE, NEVER_ROUTE and ALIASES come from config/routing.toml [routing], OPERATOR_GATED from
# [dispatch].operator_gated, via apply_policy.


def discover(quota: dict[str, Any] | None = None) -> list[Service]:
    """Build the live service list: curated profiles + whatever exists now."""
    quota = quota or {}
    services = {s.name: s for s in SERVICES}
    known_clis = {s.cli.split()[0] for s in SERVICES} | set(services)

    for name in sorted(set(quota) | paseo_providers()):
        canonical = ALIASES.get(name, name)
        if canonical in services or canonical in known_clis:
            continue                                # same account, already profiled
        if name in ("codexbar-query-errors",) or name in NEVER_ROUTE or name in OPERATOR_GATED:
            continue
        services[name] = Service(
            name=name, cli=name, good_at=dict(DEFAULT_PROFILE),
            billing=(quota.get(name, {}).get("billing_kind") or "unknown"),
            note="discovered; no curated profile — bulk/mechanical only",
        )
    return list(services.values())


# -- routing --------------------------------------------------------------

def frontier_gate() -> dict[str, float]:
    """The effective `frontier` gate (config/gates.toml [frontier]: the standing allowance since 2026-10-27, all-closed when the file is
    unreadable; bin/ade_gates.py). Re-read per call: the file is tiny."""
    return ade_gates.load_frontier()[0]


def frontier_per_wave(pool: str, gate: dict[str, float] | None = None, quota: dict[str, Any] | None = None,
                      now: datetime | None = None) -> int:
    """Most frontier slices one wave puts on `pool`: frontier1_per_wave for claude, frontier2_per_wave for every other pool.

    A cap above the closed per-wave (ade_gates.FRONTIER_DEFAULTS, 1) is the standing allowance (gates.toml, docs/gates.md), and it holds only
    while that allowance's own checks pass (2026-10-27, adversary round 1 P1): the family's `*_judged` key at 1 or more, and
    `ade_gates.judged_pool_block` (the one copy acp-dispatch's grant uses) empty: for claude the merged snapshot's Claude reading
    (`claude_quota_state`: aiuse and `paseo usage ls`) under 30 minutes old, its tightest window at least frontier1_window_min_left
    and the Fable cap at least frontier1_min_left, so a missing, stale or unknown reading (a Paseo report that is not `available`)
    falls back to the closed cap; for any other pool its reading in `quota` at least frontier2_min_left. Otherwise the closed per-wave."""
    gate = gate or frontier_gate()
    fam = 1 if pool == "claude" else 2
    cap = int(gate[f"frontier{fam}_per_wave"])
    closed = int(ade_gates.FRONTIER_DEFAULTS[f"frontier{fam}_per_wave"])
    if cap <= closed:
        return cap
    if gate.get(f"frontier{fam}_judged", 0) < 1:
        return closed
    block = ade_gates.judged_pool_block(fam, gate, now or datetime.now(UTC), claude_quota_state(now) if fam == 1 else None,
                                        ((quota or {}).get(pool) or {}).get("remaining"))
    return closed if block else cap


@dataclass
class Choice:
    service: Service
    remaining: float | None
    score: float
    why: str = ""
    alternatives: list[str] = field(default_factory=list)
    model: str = ""                 # "<model> [--effort L]" for paseo run --thinking
    kind: str = ""                  # recorded as --label ade.kind=… on paseo run

    @property
    def dispatch(self) -> str:
        """Launch template: native `paseo run` (Wave 6; acp-dispatch is transitional only).
        Cursor Cloud uses cursor-cloud launch. Callers add placement flags and the brief."""
        agent = self.service.acp_agent
        mode = DISPATCH_MODES.get(agent)
        mode_args = ["--mode", mode] if mode else []
        # DISPATCH_EXTRA retained for config compatibility; unused on the native path
        # (was appended to acp-dispatch lines; empty in config/routing.toml).
        _ = DISPATCH_EXTRA.get(agent, "")
        # Whitespace split keeps literal backslashes in model ids (shlex.split would eat them).
        parts = self.model.split(None, 1)
        if agent == "cursor-cloud":
            return ("cursor-cloud launch --repo <url> --ref <branch> --prompt-file <brief>"
                    + (f" --model {shlex.quote(parts[0])}" if parts else ""))
        if agent == "pi":
            # Keep provider and full physical namespace together, translating only explicit effort.
            spec = shlex.split(self.model)
            if not spec or len(spec) not in (1, 3) or (len(spec) == 3 and spec[1] != "--effort"):
                raise ValueError("invalid Pi dispatch profile")
            argv = ["paseo", "run", "--provider", f"pi/{spec[0]}"]
            if len(spec) == 3:
                argv += ["--thinking", spec[2]]
            argv += mode_args
            if self.kind:
                argv += ["--label", f"ade.kind={self.kind}"]
            return shlex.join(argv + ["--no-wait"])
        if not parts:
            return (f"paseo run --provider {agent}/<id from: paseo provider models {agent}> "
                    + (shlex.join(mode_args) + " " if mode_args else "")
                    + (f"--label ade.kind={self.kind} " if self.kind else "")
                    + "--no-wait")
        argv = ["paseo", "run", "--provider", f"{agent}/{parts[0]}"]
        # suggest_model may append " --effort LEVEL"; map to paseo --thinking.
        if len(parts) == 2:
            rest = parts[1].split()
            if len(rest) >= 2 and rest[0] == "--effort":
                argv += ["--thinking", rest[1]]
        argv += mode_args
        if self.kind:
            argv += ["--label", f"ade.kind={self.kind}"]
        return shlex.join(argv + ["--no-wait"])


# DISPATCH_EXTRA comes from [dispatch].extra in config/routing.toml.


def suggest_model(svc: Service, kind: str, info: dict[str, Any]) -> str:
    """The model/effort to pass for `kind` on `svc`, from its profile.

    A frontier slice is never handed a cheaper model (operator 2026-11-13: "If we are out of Fable use for a time period we
    should wait, not automatically degrade"): while claude's Fable sublimit is short `route` does not offer claude for
    `frontier` at all (`fable_short`), so this never substitutes Opus for Fable."""
    model = svc.models.get(kind, "")
    if svc.name == "opencode-go" and model:
        from go_model_policy import classification
        if classification(model.split()[0]) != "routine":
            raise ValueError("routine Go routing requires a classified routine model")
    return model


def quality_best(kind: str, services: list[Service],
                 exclude: frozenset[str] | set[str] = frozenset(),
                 quota: dict[str, Any] | None = None) -> Service | None:
    """The best-ranked pool eligible for `kind` (headroom aside, bar the `plenty_kinds` gate,
    which reads `quota`) that anchors the quality band ([routing].quality_max_rank_gap).
    Reserves and excluded pools never anchor it."""
    pool = [s for s in services
            if s.eligible(kind, quota) and s.name not in exclude and not s.reserve_floor]
    return min(pool, key=lambda s: (s.rank_for(kind), s.name), default=None)


def unrouted_why(kind: str, quota: dict[str, Any] | None = None,
                 exclude: frozenset[str] | set[str] = frozenset()) -> str:
    """Why route() found nothing for `kind`, for plan's queued line."""
    gap = QUALITY_MAX_RANK_GAP.get(kind)
    fable = fable_wait_why((quota or {}).get("claude")) if kind == "frontier" else None
    if fable:
        return fable
    best = quality_best(kind, list(discover(quota or {})), exclude, quota)
    if gap is None or best is None:
        return "no pool has room: keep queued"
    return (f"no pool within {gap} rank steps of the best for {kind} ({best.name} "
            f"r{best.rank_for(kind)}) has room; weaker pools are not used for {kind} "
            f"([routing].quality_max_rank_gap): keep queued until a reset")


def fable_short(info: dict[str, Any] | None) -> bool:
    """Is the Fable sublimit of the claude pool reading below frontier1_min_left? Then claude is short for `frontier`: it is
    not a candidate (never Opus in its place; operator 2026-11-13), and the slice waits for the Fable window or goes to
    another frontier family under the usual order."""
    fable = ((info or {}).get("sublimits") or {}).get("fable")
    return fable is not None and fable < frontier_gate()["frontier1_min_left"]


def fable_wait_why(info: dict[str, Any] | None, now: datetime | None = None) -> str | None:
    """The plan line for a frontier slice that has no pool because claude's Fable sublimit is short: wait, never degrade to
    Opus, naming the Fable window's reset when the quota reading carries one (`sublimit_resets`). None when Fable is not short."""
    if not fable_short(info):
        return None
    left = ((info or {}).get("sublimits") or {}).get("fable")
    floor = frontier_gate()["frontier1_min_left"]
    when = ((info or {}).get("sublimit_resets") or {}).get("fable")
    text = (f"WAIT for Fable 5.2, do not run this on Opus: claude's Fable window has {left:g}% left (floor {floor:g}%) and no "
            "other frontier pool was eligible")
    stamp = None
    if when:
        try:
            stamp = datetime.fromisoformat(str(when))
            stamp = stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)
        except (ValueError, TypeError):
            stamp = None
    if stamp is None:
        text += "; the Fable reset time is not in the quota reading"
    elif stamp <= (now or datetime.now(UTC)):
        text += f"; the Fable window's reset {stamp.astimezone(UTC):%Y-%m-%dT%H:%M:%SZ} has passed: re-read the quota"
    else:
        text += f"; the Fable window resets at {stamp.astimezone(UTC):%Y-%m-%dT%H:%M:%SZ}"
    return text + "; record the work with bin/fable-wait add"


def estimate_from_history(values: list[float], floor: float, default: float = 3.0, cap: float | None = None) -> float:
    """acp-dispatch's slice estimate (percent of a pool), the one rule `estimate_pct` and `pool_fits` share: the median of
    the measured slices; fewer than 3 of them never beat the estimate floor; no measurement is the brief-size `default`
    raised to the floor. `cap` (a repo override, `repo_floors`) is an upper bound on the result."""
    if values:
        est = sorted(values)[len(values) // 2]
        if len(values) < 3 and floor:
            est = max(est, floor)
    else:
        est = max(default, floor) if floor else default
    return min(est, cap) if cap is not None else est


def estimate_windows_from_rows(rows: list[dict[str, Any]], floor: float, labels: list[str] | tuple[str, ...] = (),
                               cap: float | None = None) -> dict[str, float]:
    """Median measured drop per quota window (label -> percent) from history rows, as acp-dispatch's
    `estimate_windows` (adversary d13f2ed A2): a window with fewer than three comparable measurements is estimated at least
    at the floor, and once any window is measured every label of the reading is too. `cap` bounds each estimate."""
    seen: dict[str, list[float]] = {}
    for row in rows:
        try:
            for label, used in (row.get("measured_usage_windows") or {}).items():
                seen.setdefault(label, []).append(float(used))
        except (TypeError, ValueError, AttributeError):
            pass
    est = {label: (max(sorted(v)[len(v) // 2], floor) if floor and len(v) < 3 else sorted(v)[len(v) // 2])
           for label, v in seen.items() if v}
    if est and floor:
        for label in labels:
            est.setdefault(label, floor)
    if cap is not None:
        est = {k: min(v, cap) for k, v in est.items()}
    return est


def window_fit(estimates: dict[str, float], windows: dict) -> tuple[str | None, bool]:
    """(refusal reason or None, near-limit) comparing each window's estimate with its own remaining (acp-dispatch's check)."""
    near = False
    for label, est in sorted(estimates.items()):
        rem = windows.get(label)
        if rem is None:
            continue
        if est > float(rem):
            return f"estimated use {est:.1f}% > {float(rem):.1f}% left on {label}", near
        near = near or est <= float(rem) <= est * 1.5
    return None, near


def same_workload(row: dict, kind: str | None, effort: str | None, strict: bool = False) -> bool:
    """Does a history row measure the same workload (kind and effort) as the request? A field the row does not carry cannot
    contradict the request; `strict` (a kind with its own estimate floor) requires equal, recorded fields. Reached from
    `history_rows`, which acp-dispatch's `_history_rows` and the planner's `kind_rows` share (adversary 7802361 A3,
    bcdd223 A1 and d13f2ed A1 are the cases behind the rule)."""
    pairs = ((row.get("kind"), kind), (row.get("effort"), effort))
    if strict:
        return all(want is not None and have == want for have, want in pairs)
    return all(have is None or have == want for have, want in pairs)


def record_paths(items: list[str]) -> list[Path]:
    """Job record files under state roots (`ROOT/jobs/*.json` and `ROOT/*/jobs/*.json`) or listed .json files."""
    paths: list[Path] = []
    for item in items:
        p = Path(item).expanduser()
        if p.is_dir():
            paths += sorted(set(p.glob("jobs/*.json")) | set(p.glob("*/jobs/*.json")))
        elif p.suffix == ".json":
            paths.append(p)
    return paths


PLACEHOLDER_MODELS = frozenset({"m1"})   # test placeholders (acp-dispatch passes its own PLACEHOLDER_MODELS, the same set)


def load_history(paths: list[Path]) -> list[tuple[float, dict]]:
    """(mtime, row) of every readable record under `paths` that carries a measurement; the unfiltered half of `history_rows`."""
    rows: list[tuple[float, dict]] = []
    for path in paths:
        try:
            row = json.loads(path.read_text())
            mtime = path.stat().st_mtime
        except (OSError, ValueError, TypeError):
            continue
        if not isinstance(row, dict):
            continue
        if row.get("measured_usage_pct") is None and not row.get("measured_usage_windows"):
            continue
        rows.append((mtime, row))
    return rows


def select_history(rows: list[tuple[float, dict]], agent: str, model: str | None, *, skip_placeholders: bool,
                   placeholder_models: frozenset[str] = PLACEHOLDER_MODELS, kind: str | None = None,
                   effort: str | None = None, strict: bool = False) -> list[tuple[float, dict]]:
    """The `load_history` rows matching agent x model x kind x effort, newest first."""
    out = [(mtime, row) for mtime, row in rows
           if row.get("agent") == agent and row.get("model") == model and same_workload(row, kind, effort, strict)
           and not (skip_placeholders and str(row.get("model") or "") in placeholder_models)]
    out.sort(key=lambda t: t[0], reverse=True)
    return out


def history_rows(paths: list[Path], agent: str, model: str | None, *, skip_placeholders: bool,
                 placeholder_models: frozenset[str] = PLACEHOLDER_MODELS, kind: str | None = None,
                 effort: str | None = None, strict: bool = False) -> list[tuple[float, dict]]:
    """(mtime, row) for measured records matching agent x model x kind x effort, newest first (acp-dispatch's `_history_rows`)."""
    return select_history(load_history(paths), agent, model, skip_placeholders=skip_placeholders,
                          placeholder_models=placeholder_models, kind=kind, effort=effort, strict=strict)


FRONTIER_HISTORY_MAX = 20           # acp-dispatch's machine-wide history window (measured_history)
_FRONTIER_HISTORY_MEMO: dict[str, tuple[float, list[tuple[float, dict]]]] = {}   # state roots -> (read at, load_history rows)
FRONTIER_HISTORY_TTL = 30.0


def frontier_model_tokens() -> list[str]:
    """Union of [dispatch].frontier_models (untiered extras such as gemini-4-argon) and
    every spelling/alias of each tiered vendor's frontier role from config/model-tiers.toml."""
    toks: list[str] = []
    seen: set[str] = set()
    for tok in list((POLICY.get("dispatch") or {}).get("frontier_models") or []) + list(
        _model_tiers.frontier_tokens(MODEL_TIERS)
    ):
        low = str(tok).lower()
        if low and low not in seen:
            seen.add(low)
            toks.append(str(tok))
    return toks


def is_frontier_model(model: str | None) -> bool:
    """A frontier token (dispatch list ∪ model-tiers frontier spellings) is a substring of the model."""
    low = (model or "").lower()
    return bool(low) and any(str(tok).lower() in low for tok in frontier_model_tokens())


def floor_lookup(table: dict[str, float], name: str, kind: str | None, frontier_model: bool) -> float | None:
    """The estimate floor `table` gives a slice of service `name`, or None when it names none: `SERVICE:frontier` floors a
    [dispatch].frontier_models slice and wins over `SERVICE:KIND`, which wins over `SERVICE`. The one lookup of the planner
    (`estimate_floor`) and of acp-dispatch (`estimate_floor_and_cap`)."""
    floor = table.get(name)
    if kind and kind != "frontier" and f"{name}:{kind}" in table:
        floor = table[f"{name}:{kind}"]
    if frontier_model and f"{name}:frontier" in table:
        floor = table[f"{name}:frontier"]
    return floor


def kind_floor_applies(floors: dict[str, float], name: str, kind: str | None) -> bool:
    """Is there an estimate floor for exactly this service's kind (`SERVICE:KIND`, kind not frontier)? Then history is matched strictly."""
    return bool(kind) and kind != "frontier" and f"{name}:{kind}" in floors


def base_floors() -> dict[str, float]:
    """[dispatch.estimate_floor] as floats (acp-dispatch's ESTIMATE_FLOOR)."""
    return {str(k): float(v) for k, v in ((POLICY.get("dispatch") or {}).get("estimate_floor") or {}).items()}


def planned_spec(svc: Service, kind: str, info: dict[str, Any]) -> tuple[str | None, str | None]:
    """(model, effort) `plan` would hand acp-dispatch for `kind` on `svc` (`suggest_model`: the profile's model, claude's
    frontier slot is always Fable); None for a part the profile does not name."""
    try:
        spec = suggest_model(svc, kind, info).split()
    except ValueError:
        return None, None
    effort = spec[spec.index("--effort") + 1] if "--effort" in spec and spec.index("--effort") + 1 < len(spec) else None
    return (spec[0] if spec else None), effort


def kind_rows(svc: Service, kind: str, info: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """The newest machine-wide measured slices of `kind` on the model and effort `plan` would hand acp-dispatch for `svc`, selected
    by the same filter acp-dispatch's `measured_history` uses (the planner has no task of its own, so only the machine-wide
    half). `ROUTE_AGENT_CALIBRATED_FLOOR=off` (the test suite) reads none. The record files are read once per state root and
    30 s, for every service and kind."""
    if os.environ.get("ROUTE_AGENT_CALIBRATED_FLOOR", "").strip().lower() in ("off", "0", "no", "false"):
        return []
    info = info or {}
    sf = Path(os.environ.get("SESSION_FINDER_STATE") or (Path.home() / ".local/state/session-finder"))
    key = f"{ACP_DISPATCH_STATE}|{sf}"
    now = time.time()
    hit = _FRONTIER_HISTORY_MEMO.get(key)
    if not hit or now - hit[0] >= FRONTIER_HISTORY_TTL:
        hit = (now, load_history(record_paths([str(ACP_DISPATCH_STATE), str(sf)])))
        _FRONTIER_HISTORY_MEMO[key] = hit
    model, effort = planned_spec(svc, kind, info)
    chosen = select_history(hit[1], svc.agent or svc.name, model, skip_placeholders=True, kind=kind, effort=effort,
                            strict=kind_floor_applies(base_floors(), svc.name, kind))
    return [r for _, r in chosen[:FRONTIER_HISTORY_MAX]]


_REPO_MEMO: dict[str, str | None] = {}


def repo_of(directory: str | os.PathLike[str] | None) -> str | None:
    """Repository name of a working directory, lower case: the `origin` remote's last path part (a worktree such as
    ~/src/tendcf-foo-wt has the remote of its repository), else the basename of the git common dir's parent, else None."""
    if directory is None:
        return None
    key = str(Path(directory).expanduser().resolve())
    if key in _REPO_MEMO:
        return _REPO_MEMO[key]

    def git(*argv: str) -> str:
        try:
            r = subprocess.run(["git", "-C", key, *argv], capture_output=True, text=True, timeout=10, check=False)
        except (OSError, subprocess.SubprocessError):
            return ""
        return r.stdout.strip() if r.returncode == 0 else ""
    name: str | None = None
    url = git("remote", "get-url", "origin")
    if url:
        name = url.rstrip("/").rsplit("/", 1)[-1].rsplit(":", 1)[-1]
        name = name.removesuffix(".git")
    if not name:
        common = git("rev-parse", "--path-format=absolute", "--git-common-dir")
        if common:
            top = Path(common)
            name = (top.parent if top.name == ".git" else top).name
    name = name.lower() if name else None
    _REPO_MEMO[key] = name
    return name


def repo_floors(repo: str | None) -> dict[str, float]:
    """The `[dispatch.repo_overrides.REPO.estimate_floor]` table of `repo` (operator 2026-11-01), {} for any other repo."""
    if not repo:
        return {}
    table = ((POLICY.get("dispatch") or {}).get("repo_overrides") or {}).get(str(repo).lower()) or {}
    return {str(k): float(v) for k, v in (table.get("estimate_floor") or {}).items()}


def estimate_floor(svc: Service, kind: str, info: dict[str, Any], repo: str | None = None) -> tuple[float, float | None]:
    """(estimate floor, cap) of a `kind` slice on `svc` in `repo`, by the lookup acp-dispatch's `estimate_floor_and_cap` uses
    (`floor_lookup`, on the model `plan` would hand it): [dispatch.estimate_floor], replaced by the repo's override when that
    names the slice, which is then also the cap. (0.0, None): no floor, whatever the service or kind."""
    model, _ = planned_spec(svc, kind, info)
    frontier = is_frontier_model(model)
    over = floor_lookup(repo_floors(repo), svc.name, kind, frontier)
    if over is not None:
        return over, over
    base = floor_lookup(base_floors(), svc.name, kind, frontier)
    return (base if base is not None else 0.0), None


def pool_fits(svc: Service, kind: str, info: dict[str, Any], *, min_headroom: float = 15.0, repo: str | None = None) -> bool:
    """Would acp-dispatch admit a `kind` slice onto `svc` given its reading `info` (remaining, windows)? The router floor, and
    for EVERY service and kind (floor or none, measured or not) the same fit acp-dispatch applies: each window's measured
    estimate against that window's own remaining when a window estimate applies, else the scalar estimate against the tightest
    window. Both callers use the same rows, filters, floor lookup and arithmetic (`kind_rows`, `estimate_floor`,
    `estimate_from_history`, `estimate_windows_from_rows`, `window_fit`); there is no early return for a service without a
    floor, so measured history binds an unfloored pool too. Unmeasured, the planner's estimate is acp-dispatch's smallest
    brief-size default (3%, raised to the floor): it has no brief. A task's own history is invisible to the planner (a slice
    sent from a task with 3+ own measured slices can be estimated differently), as is a slice's in-flight reservation. The
    verdict also assumes the slice is routed with the model and effort `plan` prints (`models.KIND`, `--effort high`): a
    dispatch without `--effort` filters the history on no effort and can read other rows (2026-11-01 live: median 12 and a
    5-hour estimate of 100, against 2 and 73), so route with the effort `plan` prints."""
    left = info.get("remaining")
    if left is None:
        return True
    if left < max(min_headroom, svc.reserve_floor):
        return False
    floor, cap = estimate_floor(svc, kind, info, repo)
    rows = kind_rows(svc, kind, info)
    windows = {k: v for k, v in (info.get("windows") or {}).items() if v is not None}
    per_window = {k: v for k, v in estimate_windows_from_rows(rows, floor, list(windows), cap).items()
                  if windows.get(k) is not None}
    if per_window:
        return window_fit(per_window, windows)[0] is None
    pcts = [float(r["measured_usage_pct"]) for r in rows if r.get("measured_usage_pct") is not None]
    return left >= estimate_from_history(pcts, floor, cap=cap)


def pool_usable(svc: Service, kind: str, quota: dict[str, Any], *, min_headroom: float = 15.0,
                repo: str | None = None) -> bool:
    """Could `svc` take `kind` now, by quota and readiness alone (not a wave cap or `exclude`)? Short means: ineligible,
    not ready, claude's Fable sublimit under its floor (for `frontier`), or the pool's tightest window not fitting the slice
    (`pool_fits`). A pool with no reading is usable unless it is a reserve or a fallback (fail closed)."""
    info = (quota or {}).get(svc.name) or {}
    if not svc.eligible(kind, quota) or not service_ready(svc):
        return False
    if svc.name == "claude" and kind == "frontier" and fable_short(info):
        return False                       # not a candidate, never Opus in its place
    left = info.get("remaining")
    if left is None:
        return not (svc.reserve_floor or svc.fallback_after)
    return pool_fits(svc, kind, info, min_headroom=min_headroom, repo=repo)


def fallback_block(svc: Service, kind: str, quota: dict[str, Any], *, services: dict[str, Service] | None = None,
                   min_headroom: float = 15.0, repo: str | None = None) -> str | None:
    """Why `svc`, a fallback (`fallback_after`), may not take `kind` now: every service it sits behind is usable. None when it
    may (some pool it sits behind is short, or it is no fallback). The one predicate of the planner (`route`) and of
    acp-dispatch's fallback-only enforcement. `services` maps names to the services that exist (default: the whole policy,
    a name not in it counts as short)."""
    if not svc.fallback_after:
        return None
    known = BY_NAME if services is None else services
    ok = [n for n in svc.fallback_after
          if n in known and pool_usable(known[n], kind, quota, min_headroom=min_headroom, repo=repo)]
    if len(ok) < len(svc.fallback_after):
        return None
    return (f"{svc.name} is a fallback behind {', '.join(svc.fallback_after)} (operator 2026-10-31) and "
            f"{', '.join(ok)} can take --kind {kind} now; use it only when one is short of quota, or "
            f"ACP_OPERATOR_APPROVED=route-override")


def route(kind: str, *, quota: dict[str, Any] | None = None,
          min_headroom: float = 15.0,
          exclude: frozenset[str] | set[str] = frozenset(), repo: str | None = None,
          avoid: frozenset[str] | set[str] = frozenset()) -> Choice | None:
    """Choose a service for `kind`, preferring idle paid capacity for bulk.

    Score = rank + (100 − remaining) × weight / 10, then pace/reset adjustments
    (2026-10-18): burn_first_bonus when expected waste at reset is high (or the
    static TOML flag when waste is unknown), and a pace_penalty when the
    binding window is burning ahead of schedule.

    `exclude` names services to skip (full for this wave, or just failed). `avoid` (route_adjust holds) skips
    candidates the same way but, unlike `exclude`, does not move the quality band's anchor."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    quota = {} if quota is None else quota
    services = list(discover(quota))
    best = quality_best(kind, services, exclude, quota)
    gap = QUALITY_MAX_RANK_GAP.get(kind)
    by_name = {s.name: s for s in services}

    scored: list[tuple[float, Service, float | None, list[str]]] = []
    for svc in services:
        if not svc.eligible(kind, quota) or svc.name in exclude or svc.name in avoid:
            continue
        if kind != "api-only" and not service_ready(svc):
            continue                       # e.g. omp without a working Anthropic login
        if kind == "frontier" and svc.name == "claude" and fable_short(quota.get("claude")):
            continue                       # Fable short: wait for its window, never hand a frontier slice to Opus (operator 2026-11-13)
        if fallback_block(svc, kind, quota, services=by_name, min_headroom=min_headroom, repo=repo) is not None:
            continue                       # a fallback: only while a pool it sits behind is short
        if gap is not None and best is not None and svc.rank_for(kind) - best.rank_for(kind) > gap:
            continue                       # outside the quality band: quota never buys this pool in
        info = quota.get(svc.name) or {}
        remaining = info.get("remaining")
        if remaining is not None and not pool_fits(svc, kind, info, min_headroom=min_headroom, repo=repo):
            continue                       # too tight to hand work to, a reserve at its floor, or (frontier) under the slice estimate acp-dispatch demands
        if remaining is None and (svc.reserve_floor or svc.fallback_after):
            continue                       # a reserve or a fallback with no fresh reading fails closed (review 2026-10-15; Argon 2026-10-31)
        # Lower is better. Rank encodes fitness; headroom pulls idle pools up
        # for bulk work and is only a tie-break for judgment, where capability
        # must dominate cost.
        weight = 1.0 if kind in ("bulk", "mechanical", "research") else 0.25
        if remaining is None:
            # Unmeasured capacity is a worse bet than measured headroom: we
            # cannot tell whether it is idle or exhausted. Penalise it so a
            # peer with known room wins, while still leaving it reachable as
            # a last resort rather than dropping it from the roster.
            pressure = 5.0
        else:
            pressure = (100.0 - remaining) * weight / 10.0
        rank = svc.rank_for(kind) + pressure
        tags: list[str] = []
        waste = expected_waste(remaining, info.get("pace_ratio"),
                               info.get("resets_at"), info.get("window_minutes"))
        grant = False
        if waste is None and svc.grant_days:
            waste = grant_waste(remaining, info.get("resets_at"), svc.grant_days)
            grant = waste is not None
        if waste is not None:
            # Reserves keep their floor gate; never boost them to burn unused
            # quota (2026-10-18 review finding 6c).
            # A fallback (Argon) never outranks a usable pool it sits behind: no bonus either (adversary N1, 2026-11-01).
            if waste >= BURN_FIRST_WASTE_MIN and not svc.reserve_floor and not svc.fallback_after:
                rank -= BURN_FIRST_BONUS
                if grant:
                    tags.append(f"burn before reset: {waste:.0f}% of the grant is ahead "
                                "of an even spend and expires unspent otherwise")
                else:
                    tags.append(f"would waste {waste:.0f}% at reset")
        elif svc.burn_first and not svc.fallback_after and remaining is not None and remaining >= BURN_FIRST_MIN:
            # Static TOML fallback only when waste cannot be computed.
            rank -= BURN_FIRST_BONUS
        pace = info.get("pace_ratio")
        if pace is not None:
            try:
                pace_f = float(pace)
            except (ValueError, TypeError):
                pace_f = None
            if pace_f is not None and pace_f > PACE_PENALTY_ABOVE:
                pen = PACE_PENALTY
                if kind in ("judgment", "frontier"):
                    pen = pen * PACE_PENALTY_JUDGMENT_FACTOR
                rank += pen
                tags.append(f"pace {pace_f:.1f}× (penalty {pen:g})")
        scored.append((rank, svc, remaining, tags))

    if not scored:
        return None
    # A fallback (Argon) sorts behind every candidate it sits behind, whatever the scores say: ordering is structural, not
    # a tie of rank + pressure + penalties (Codex review of PR 224, round 6: codex 60% left at pace 1.6 scored 5, tied Argon,
    # and the name broke the tie). The pool must be in `scored`, i.e. take the kind now; a named pool a wave cap or an
    # `exclude` took out leaves Argon the overflow.
    candidates = {s.name for _, s, _, _ in scored}
    scored.sort(key=lambda t: (any(n in candidates for n in t[1].fallback_after), t[0], t[1].name))
    best_score, best, remaining, tags = scored[0]
    why = [f"{kind}: {best.cli}"]
    if remaining is not None:
        why.append(f"{remaining:.0f}% headroom")
    why.extend(tags)
    if best.billing == "free":
        why.append("free tier")
    elif kind in ("bulk", "mechanical") and remaining is not None and remaining > 80:
        why.append("idle paid capacity")
    if best.reserve_floor and not best.measured_only:
        why.append(f"RESERVE: floor {best.reserve_floor:.0f}% left, one small slice, "
                   "check the window first")
    if best.note:
        why.append(best.note)
    return Choice(best, remaining, best_score, "; ".join(why),
                  [s.name for _, s, _, _ in scored[1:4]],
                  model=suggest_model(best, kind, quota.get(best.name) or {}),
                  kind=kind)


def canary_pool(svc: Service) -> str | None:
    """Quota identity for pools whose meter cannot warn before a first refusal."""
    provider = svc.pool[0] if svc.pool else (svc.shares_pool or svc.name)
    if svc.acp_agent == "antigravity":
        provider = "antigravity"
    return provider if provider in CANARY_POOLS else None


def plan(kinds: list[str], *, quota: dict[str, Any] | None = None,
         min_headroom: float = 15.0,
         exclude: frozenset[str] | set[str] = frozenset(), repo: str | None = None,
         kind_exclude: dict[str, set[str]] | None = None,
         reject: Callable[[str, Choice], str | None] | None = None,
         refusals: list[str | None] | None = None
         ) -> list[tuple[str, Choice | None]]:
    """Assign each slice kind to a service for ONE wave, right now.

    `kind_exclude` (route_adjust, W8) holds pools off per kind (`route(avoid=)`, so the quality band
    keeps its anchor); it is soft: a kind that finds no room, or only a choice `reject` refuses, is routed
    again with them allowed, so a hold never strands a kind. `reject(kind, choice)` returns a refusal
    reason or None; a refused slice comes back None, takes no wave slot, and its reason is appended to
    `refusals` (one entry per slice, None when not refused).

    Greedy in the given order (put the hardest first), honouring each
    service's `max_parallel` so a wave spreads over pools. Slices that
    find no room come back as None: leave them queued and re-plan when a
    slice finishes. Re-run it at every wave boundary; it is a snapshot-file
    read, so it is instant and costs no tokens."""
    load: dict[str, int] = {}
    canaries: set[str] = set()
    frontier: dict[str, int] = {}
    full = set(exclude)
    out: list[tuple[str, Choice | None]] = []
    for kind in kinds:
        skip = full | {s.name for s in discover(quota or {})
                       if canary_pool(s) in canaries}
        if kind == "frontier":
            gate = frontier_gate()
            skip = skip | {n for n, k in frontier.items() if k >= frontier_per_wave(n, gate, quota)}
        held = (kind_exclude or {}).get(kind) or set()
        choice = route(kind, quota=quota, min_headroom=min_headroom, exclude=skip, repo=repo, avoid=held)
        reason = reject(kind, choice) if reject and choice is not None else None
        if held and (choice is None or reason):
            retry = route(kind, quota=quota, min_headroom=min_headroom, exclude=skip, repo=repo)
            retry_reason = reject(kind, retry) if reject and retry is not None else None
            if retry is not None and (choice is None or not retry_reason):
                choice, reason = retry, retry_reason
        if reason:
            choice = None                  # refused: no wave slot, the caller reports the reason
        if refusals is not None:
            refusals.append(reason)
        if choice is not None:
            name = choice.service.name
            pool = canary_pool(choice.service)
            if pool:
                canaries.add(pool)
                full.add(name)
            load[name] = load.get(name, 0) + 1
            if kind == "frontier":
                frontier[name] = frontier.get(name, 0) + 1
            if load[name] >= choice.service.max_parallel:
                full.add(name)
        out.append((kind, choice))
    return out


# HERMES_MODELS and HERMES_PROVIDER_NAME come from [hermes] in config/routing.toml.


def hermes_chain(quota: dict[str, Any] | None = None) -> list[dict[str, str]]:
    """Build Hermes's provider chain: free-first, then paid, headroom-ordered.

    Hermes's own `fallback_providers` only reacts to *failure* — it has no
    notion of cost or headroom, and cannot see pools Hermes has no provider
    for. This generates it from the same capability + headroom model the
    router uses, restricted to what we may legitimately call as an API.
    """
    quota = quota or {}
    eligible = [s for s in SERVICES if s.access == "api" and not s.retired]
    # Free before paid; within a tier, more headroom first. A pool we cannot
    # measure sorts last rather than being dropped.
    def key(s: Service) -> tuple[int, float]:
        rem = (quota.get(s.name) or {}).get("remaining")
        return (0 if s.billing == "free" else 1,
                -(rem if rem is not None else -1.0))
    chain = []
    for svc in sorted(eligible, key=key):
        for model in HERMES_MODELS.get(svc.name, []):
            chain.append({"provider": HERMES_PROVIDER_NAME.get(svc.name, svc.name),
                          "model": model,
                          "_pool": svc.name,
                          "_billing": svc.billing})
    return chain


def apply_hermes_chain(chain: list[dict[str, str]]) -> str:
    """Write the chain into Hermes's config.

    `hermes fallback add` is an interactive picker, so a generated chain has
    to be written to config.yaml directly. The primary is the chain head; the
    remainder becomes fallback_providers.
    """
    cfg = Path.home()/".hermes/config.yaml"
    text = cfg.read_text()
    backup = cfg.with_suffix(f".yaml.bak-generated-{datetime.now():%Y%m%d%H%M%S}")
    backup.write_text(text)

    head, *rest = chain
    text = re.sub(r"(?m)^model:\n(?:  .*\n)+",
                  "model:\n"
                  "  # GENERATED by bin/route_agent.py hermes-chain --apply.\n"
                  "  # Edit the model table there, not here.\n"
                  f"  provider: {head['provider']}\n"
                  f"  default: {head['model']}\n"
                  "  allow_paid_opencode_zen: false\n", text, count=1)
    body = "".join(f"  - provider: {e['provider']}\n    model: {e['model']}\n"
                   for e in rest)
    text = re.sub(r"(?m)^fallback_providers:\n(?:(?:  #.*|  - .*|    .*)\n)*",
                  "fallback_providers:\n"
                  "  # GENERATED — free tiers first, paid pools last. Only\n"
                  "  # providers whose terms permit direct API use appear here;\n"
                  "  # everything else is reachable only via its vendor CLI.\n"
                  + body, text, count=1)
    cfg.write_text(text)
    return str(backup)


# The main-loop ("Dann") substrate chain: Flash-primary, provider failover.
# Primary and fallback serve the SAME model (deepseek-v4.1-flash), so a provider
# failover does not change the model — which is what makes it safe against
# Paseo's per-provider constraint: `set_agent_model` refuses a provider other
# than the agent's, so a cross-provider move is a NEW session, never a live
# switch (that is what killed the ◈ Dann tab on 2026-10-23). A within-provider
# switch is lifecycle-safe but must also pass the model cost policy.
# Source of truth: spec/composite-individual/deepseek-cost-routing.md.
DANN_SUBSTRATE: tuple[tuple[str, str, str], ...] = (
    ("opencode-go", "opencode", "opencode-go/deepseek-v4.1-flash"),
    ("clinepass", "cline", "cline-pass/deepseek-v4.1-flash"),
)
# Costly Go models are explicit bounded advisors, never main-loop escalations.
# A measured pool below this much headroom is "tight": still in the chain, but
# an unmeasured pool is not preferred over it.
SUBSTRATE_MIN_HEADROOM = 10.0


def _substrate_pool_state(pool: str, quota: dict[str, Any] | None,
                          accounts: list[dict[str, Any]],
                          file_age: float | None = None,
                          ignore_absent: bool = False) -> dict[str, Any]:
    """Binding allowance across all measured windows, including monthly.

    Wide-open rate windows do not replenish an exhausted monthly budget. Keep
    monthly headroom visible, but never skip it to promote a spent Go pool.

    Applies the guards `load_snapshot` applies to the same rows: a row with an
    `error` is skipped; a row older than STALE_SOFT (or `reading_expired`) measures
    nothing except an exhausted window; a file older than STALE_HARD measures
    nothing. The fresh quota dict (`aiuse --available`) can only tighten the file's
    reading, never loosen it.
    """
    remaining: float | None = None
    monthly: float | None = None
    for a in accounts:
        if a.get("provider") != pool or a.get("error"):
            continue
        row_age = _clean_age(a.get("age_seconds"))
        if row_age is None and a.get("collected_at"):
            try:
                row_age = (datetime.now(UTC)
                           - datetime.fromisoformat(str(a["collected_at"]))).total_seconds()
            except (ValueError, TypeError):
                row_age = None
        if row_age is None:
            row_age = file_age
        if (row_age is not None and row_age > STALE_HARD) or (
                file_age is not None and file_age > STALE_HARD):
            continue                                  # hard-stale: unmeasured
        old = ((row_age is not None and row_age > STALE_SOFT)
               or a.get("reading_expired") is True)
        wins = a.get("windows") or []

        def rem(w: dict[str, Any]) -> float | None:
            head = _pct(w.get("headroom_percent"))
            return head if head is not None else _pct(w.get("remaining_percent"))

        def is_month(w: dict[str, Any]) -> bool:
            return "month" in ((w.get("label") or "").lower())

        exhausted = (a.get("usable_now") is False
                     or any(w.get("state") == "exhausted" for w in wins))
        measured = [] if old else [x for x in (rem(w) for w in wins) if x is not None]
        row_rem: float | None
        if exhausted:
            row_rem = 0.0
        else:
            row_rem = min(measured) if measured else None
        if row_rem is not None:
            remaining = row_rem if remaining is None else min(remaining, row_rem)
        if monthly is None and not old:
            monthly = next((rem(w) for w in wins if is_month(w)), None)
    fresh_info = (quota or {}).get(pool) or {}
    # `--available` lists only pools aiuse collects, and a disabled pool is not collected:
    # load_snapshot reads such a pool as 0% (`absent_from_available`). For the lifeline that
    # is "not measured", not "exhausted" (operator 2026-10-23), so the marker is ignored.
    fresh = None if (ignore_absent and fresh_info.get("absent_from_available")) else _pct(
        fresh_info.get("remaining"))
    if fresh is not None:
        remaining = fresh if remaining is None else min(remaining, fresh)
    return {"remaining": remaining, "monthly": monthly}


def substrate_chain(quota: dict[str, Any] | None = None,
                    accounts: list[dict[str, Any]] | None = None,
                    *, file_age: float | None = None,
                    disabled: set[str] | frozenset[str] | None = None,
                    lifeline: set[str] | frozenset[str] | None = None) -> list[dict[str, Any]]:
    """Order the main-loop substrates: healthy-measured first, unmeasured lifeline last.

    Both Flash entries serve deepseek-v4.1-flash, so a provider failover keeps
    the model constant. A pool in aiuse's `[disabled_services]` (`operator_disabled()`)
    is never chosen, except a pool named in `[substrate].lifeline` of routing.toml
    (clinepass, operator ruling 2026-10-23): that one is allowed while disabled, and
    sorts as unmeasured because aiuse does not collect it. `remaining` is None for a
    pool aiuse does not measure; such a pool sorts after a healthy one but is never
    dropped. An exhausted pool stays listed with `usable: False`; with nothing usable
    left the caller prints `no usable substrate`. `disabled` and `lifeline` default
    to the live aiuse config and the loaded policy.
    """
    quota = quota or {}
    accounts = accounts or []
    disabled_set = operator_disabled() if disabled is None else set(disabled)
    allowed = set(SUBSTRATE_LIFELINE if lifeline is None else lifeline)
    off = disabled_set - allowed
    pools = [t for t in DANN_SUBSTRATE if t[0] not in off]
    # a lifeline kept despite being disabled is not collected by aiuse: absent from
    # `--available` there means unmeasured, not exhausted
    states = {p: _substrate_pool_state(p, quota, accounts, file_age,
                                       ignore_absent=p in disabled_set & allowed)
              for p, _, _ in pools}

    def key(item: tuple[str, str, str]) -> tuple[int, float]:
        rem = states[item[0]]["remaining"]
        if rem is None:
            return (1, 0.0)                       # unmeasured lifeline: after healthy, before tight
        if rem >= SUBSTRATE_MIN_HEADROOM:
            return (0, -rem)                      # healthy -> first, most headroom wins
        if rem > 0:
            return (2, -rem)                      # tight -> yield to the lifeline
        return (3, 0.0)                           # exhausted -> last

    chain: list[dict[str, Any]] = []
    seen_usable = False
    for pool, provider, model in sorted(pools, key=key):
        rem = states[pool]["remaining"]
        usable = rem is None or rem > 0
        if not usable:
            role = "exhausted"
        elif not seen_usable:
            role, seen_usable = "primary", True
        else:
            role = "fallback"
        chain.append({
            "role": role, "usable": usable,
            "pool": pool, "provider": provider, "model": model,
            "remaining": rem, "monthly": states[pool]["monthly"],
        })
    return chain


# `route_agent.py substrate` exit codes beyond 0; 1 and 3-4 pass paseo-set-model's own through.
SUBSTRATE_EXIT_BAD_AGENT = 2          # --apply AGENT empty or ambiguous
SUBSTRATE_EXIT_NO_AGENT = 3           # --apply AGENT matches nothing
SUBSTRATE_EXIT_CROSS_PROVIDER = 5     # needs a NEW session on the primary's provider
SUBSTRATE_EXIT_NONE_USABLE = 6        # every substrate disabled or exhausted
SUBSTRATE_EXIT_CANNOT_LIST = 7        # paseo-set-model list failed or unreadable


def apply_substrate(agent: str, chain: list[dict[str, Any]]) -> tuple[int, str]:
    """Apply the chain's primary to `agent` IF it is a within-provider move.

    Returns (exit code, message). `paseo-set-model` talks to the daemon's own
    `set_agent_model` RPC, which only sets a model *within* the agent's provider. So a
    cross-provider move is refused here with the start-a-new-session instruction rather
    than attempted (attempting it is what breaks the session). The agent is an exact id
    or a unique id prefix; the id actually checked is the id passed to `set`.
    """
    primary = next((e for e in chain if e.get("usable") and e.get("role") == "primary"), None)
    if primary is None:
        return SUBSTRATE_EXIT_NONE_USABLE, "no usable substrate"
    if not agent:
        return SUBSTRATE_EXIT_BAD_AGENT, "empty agent id"
    helper = Path(__file__).resolve().parent / "paseo-set-model"
    try:
        proc = subprocess.run([str(helper), "list", "--json"], capture_output=True, text=True, check=False)
    except OSError as e:
        return SUBSTRATE_EXIT_CANNOT_LIST, f"cannot run paseo-set-model: {e}"
    if proc.returncode != 0:
        return (SUBSTRATE_EXIT_CANNOT_LIST,
                f"cannot list agents (rc={proc.returncode}): {proc.stderr.strip()[:200]}")
    try:
        data = json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError):
        return SUBSTRATE_EXIT_CANNOT_LIST, "cannot parse paseo-set-model list output"
    if not isinstance(data, list):
        return SUBSTRATE_EXIT_CANNOT_LIST, "paseo-set-model list output is not a JSON list"
    agents = [a for a in data if isinstance(a, dict)]
    match = [a for a in agents if str(a.get("id", "")) == agent]
    if not match:
        match = [a for a in agents if str(a.get("id", "")).startswith(agent)]
    if not match:
        return SUBSTRATE_EXIT_NO_AGENT, f"no such agent: {agent}"
    if len(match) > 1:
        ids = ", ".join(str(a.get("id", ""))[:12] for a in match[:5])
        return SUBSTRATE_EXIT_BAD_AGENT, f"ambiguous agent {agent!r}: {len(match)} match ({ids})"
    cur = match[0]
    if cur.get("provider") != primary["provider"]:
        return (SUBSTRATE_EXIT_CROSS_PROVIDER,
                (f"cross-provider: {agent} is {cur.get('provider')}/{cur.get('model')}; "
                 f"start a NEW session on {primary['provider']}/{primary['model']} "
                 f"(set_agent_model cannot switch providers)"))
    try:
        proc = subprocess.run([str(helper), "set", str(cur["id"]), primary["model"]],
                              capture_output=True, text=True, check=False)
    except OSError as e:
        return SUBSTRATE_EXIT_CANNOT_LIST, f"cannot run paseo-set-model: {e}"
    return (proc.returncode,
            proc.stdout.strip() or proc.stderr.strip()
            or f"set rc={proc.returncode} ({primary['model']})")


# Dispatch state root (same default as acp-dispatch). Overridable for tests.
ACP_DISPATCH_STATE = Path(os.environ.get("ACP_DISPATCH_STATE")
                          or (Path.home() / ".local" / "state" / "bigteam"))

# Copied from bin/acp-dispatch (do not import: slice B edits that file). Agent
# name → (aiuse provider, pool_family). cursor/opencode are model-dependent.
_AGENT_PROVIDER_MAP: dict[str, tuple[str, str | None]] = {
    "claude": ("claude", "default"),
    "codex": ("codex", None),
    "cursor": ("cursor", None),
    "cursor-cloud": ("cursor-cloud", None),
    "opencode": ("opencode-go", None),
    "omp": ("omp", None),
}


def map_agent_to_provider(agent: str, model: str | None) -> tuple[str, str | None] | None:
    """Map acp agent and model to aiuse (provider, pool_family). None if unknown.

    Kept in sync with acp-dispatch.map_agent_to_provider by hand (2026-10-18);
    calibrate must not import acp-dispatch while that file is mid-edit.
    """
    if agent == "pi":
        # Pi is a transport, not a billing pool. Never map every Pi model to OpenAI credits.
        provider = (model or "").split("/", 1)[0]
        if provider == "cursor":
            return "cursor", "third_party"
        if provider in ("zai", "deepseek", "google", "openrouter"):
            return provider, None
        if provider == "openai":
            return "pi", "codex_api"
        if provider == "anthropic":
            return "omp", None
        if provider == "opencode-go":
            return "opencode-go", None
        return None
    if agent == "cursor":
        if not model or model in ("default", "auto"):
            return "cursor", "auto"
        return "cursor", "third_party"
    if agent == "antigravity":
        # the Gemini 4 Argon window is its own aiuse pool family; the provider's other pools are not routed
        return ("antigravity", "gemini_argon") if (model or "").lower().startswith("gemini-4-argon") else None
    if agent == "opencode":
        if model and model.startswith("opencode-go/"):
            return "opencode-go", None
        if model and ("free" in model or model.startswith("opencode-zen-free/")):
            return "opencode-zen-free", None
        if model and model.startswith("opencode-zen/"):
            return "opencode-zen", None
    return _AGENT_PROVIDER_MAP.get(agent)


def dispatch_service_name(agent: str, model: str | None) -> str:
    """Routing service key for a dispatch record's agent+model."""
    mapping = map_agent_to_provider(agent, model)
    if mapping is None:
        return agent or "?"
    return pool_service(mapping[0], mapping[1]) or agent or "?"


def _is_test_placeholder(rec: dict[str, Any]) -> bool:
    """Skip synthetic pytest / temp-dir acp-run records."""
    if rec.get("model") == "m1":
        return True
    cmd = str(rec.get("cmd") or "")
    for part in cmd.split():
        if "acp-run" not in part:
            continue
        if "/tmp/" in part or "/var/folders/" in part or "/pytest" in part:
            return True
    return False


def _iter_job_records(state_dir: Path | None = None) -> list[dict[str, Any]]:
    """Every `*/jobs/*.json` and `*/*/jobs/*.json` under the dispatch state dir."""
    root = state_dir or ACP_DISPATCH_STATE
    out: list[dict[str, Any]] = []
    for pat in ("*/jobs/*.json", "*/*/jobs/*.json"):
        for path in sorted(glob.glob(str(root / pat))):
            try:
                data = json.loads(Path(path).read_text())
            except (OSError, ValueError):
                continue
            if isinstance(data, dict):
                data = dict(data)
                data["_path"] = path
                out.append(data)
    return out


def _record_when(rec: dict[str, Any]) -> datetime | None:
    """Best timestamp for --since filtering: finished, else started.

    Real dispatch records store epoch floats; ISO strings remain accepted.
    The `done` key is a report path, never a timestamp.
    """
    for key in ("finished", "started"):
        raw = rec.get(key)
        if raw is None or raw == "":
            continue
        if isinstance(raw, (int, float)):
            try:
                return datetime.fromtimestamp(float(raw), UTC)
            except (ValueError, OSError, OverflowError):
                continue
        try:
            stamp = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))  # noqa: FURB162  (keeps the exact Z handling for malformed input)
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=UTC)
            return stamp
        except (ValueError, TypeError):
            continue
    return None


def _no_report_class(rec: dict[str, Any]) -> str | None:
    """Class after `NO-REPORT:` in detail/failure, or status==no-report → 'no-report'."""
    for key in ("detail", "failure"):
        text = str(rec.get(key) or "")
        if text.startswith("NO-REPORT:"):
            rest = text[len("NO-REPORT:"):].strip()
            parts = rest.split("(", 1)[0].strip().split()
            return parts[0].lower() if parts else "no-report"
    if rec.get("status") == "no-report":
        return "no-report"
    return None


def _suggest_basis_counts(recs: list[dict[str, Any]]) -> tuple[int, int]:
    """(n, done) for suggestion rates: finished, non-quota, non-unavailable."""
    n = done = 0
    for rec in recs:
        if _no_report_class(rec) == "quota":
            continue
        if rec.get("unavailable_class") is not None or rec.get("status") == "unavailable":
            continue
        n += 1
        if rec.get("status") == "done":
            done += 1
    return n, done


def _median_or_none(vals: list[float]) -> float | None:
    if not vals:
        return None
    return float(statistics.median(vals))


def calibrate_report(*, since_days: float | None = None, min_n: int | None = None,
                     state_dir: Path | None = None,
                     now: datetime | None = None) -> dict[str, Any]:
    """Summarise dispatch outcomes for re-ranking good_at.

    Schema (read-only; `acp-dispatch outcome RECORD --ci/--review/--merged` writes it):
      outcome.ci      — "pass" | "fail"
      outcome.review  — "pass" | "fail"
      outcome.merged  — bool

    Groups by service × model × kind (missing kind → `?`). Skips model `m1`
    and temp-dir fake acp-run cmds. Running / unfinished records are counted
    as `in_flight` and excluded from groups. Suggestions compare each
    service×kind done rate (finished, non-quota, non-unavailable) to the
    median of at least `[calibrate].min_peers` other services eligible for
    that kind, when n ≥ min (config `[calibrate].min_outcomes`).
    """
    min_n = CALIBRATE_MIN_OUTCOMES if min_n is None else int(min_n)
    now = now or datetime.now(UTC)
    cutoff = None if since_days is None else now - timedelta(days=float(since_days))

    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    in_flight = 0
    for rec in _iter_job_records(state_dir):
        if _is_test_placeholder(rec):
            continue
        when = _record_when(rec)
        if cutoff is not None and (when is None or when < cutoff):
            continue
        if rec.get("status") == "running" or rec.get("finished") is None:
            in_flight += 1
            continue
        agent = str(rec.get("agent") or "?")
        model = rec.get("model")
        model_s = "?" if model is None else str(model)
        kind = rec.get("kind")
        kind_s = "?" if not kind else str(kind)
        service = dispatch_service_name(agent, None if model is None else str(model))
        groups.setdefault((service, model_s, kind_s), []).append(rec)

    group_rows: list[dict[str, Any]] = []
    for (service, model, kind), recs in sorted(groups.items()):
        n = len(recs)
        done = sum(1 for r in recs if r.get("status") == "done")
        no_report = 0
        quota_stop = 0
        for r in recs:
            cls = _no_report_class(r)
            if cls is not None:
                no_report += 1
                if cls == "quota":
                    quota_stop += 1
            elif r.get("unavailable_class") == "quota":
                quota_stop += 1
        usage = [float(r["measured_usage_pct"])
                 for r in recs if r.get("measured_usage_pct") is not None]
        win_vals: dict[str, list[float]] = {}
        for r in recs:
            windows = r.get("measured_usage_windows") or {}
            if isinstance(windows, dict):
                for label, val in windows.items():
                    if val is None:
                        continue
                    try:
                        win_vals.setdefault(str(label), []).append(float(val))
                    except (ValueError, TypeError):
                        pass
        ci_n = rev_n = merged_n = 0
        ci_pass = rev_pass = merged_true = 0
        for r in recs:
            out = r.get("outcome")
            if not isinstance(out, dict):
                continue
            if out.get("ci") in ("pass", "fail"):
                ci_n += 1
                if out["ci"] == "pass":
                    ci_pass += 1
            if out.get("review") in ("pass", "fail"):
                rev_n += 1
                if out["review"] == "pass":
                    rev_pass += 1
            if isinstance(out.get("merged"), bool):
                merged_n += 1
                if out["merged"]:
                    merged_true += 1
        group_rows.append({
            "service": service,
            "model": model,
            "kind": kind,
            "n": n,
            "done": done,
            "done_rate": round(100.0 * done / n, 1) if n else 0.0,
            "no_report": no_report,
            "quota_stop": quota_stop,
            "median_measured_usage_pct": _median_or_none(usage),
            "median_measured_usage_windows": {
                k: _median_or_none(v) for k, v in sorted(win_vals.items())
            },
            "outcome": {
                "ci_pass_rate": (round(100.0 * ci_pass / ci_n, 1) if ci_n else None),
                "review_pass_rate": (round(100.0 * rev_pass / rev_n, 1) if rev_n else None),
                "merged_rate": (round(100.0 * merged_true / merged_n, 1) if merged_n else None),
                "n_ci": ci_n, "n_review": rev_n, "n_merged": merged_n,
            },
        })

    # Suggestions: aggregate by service × kind (models folded). Rates use the
    # non-quota / non-unavailable basis; raw table counts stay above.
    # kind=? is a reporting bucket for legacy records with no kind — it is not
    # a good_at key, so never suggest a rank change for it (2026-10-18).
    sk: dict[tuple[str, str], dict[str, float]] = {}
    for (service, _model, kind), recs in groups.items():
        if kind == "?":
            continue
        sn, sd = _suggest_basis_counts(recs)
        key = (service, kind)
        agg = sk.setdefault(key, {"n": 0.0, "done": 0.0})
        agg["n"] += sn
        agg["done"] += sd

    # Peer medians: eligible services with n ≥ min; need ≥ min_peers others.
    by_kind: dict[str, list[tuple[str, float, float]]] = {}
    for (service, kind), agg in sk.items():
        if agg["n"] < min_n:
            continue
        svc = BY_NAME.get(service)
        if svc is None or not svc.eligible(kind, any_headroom=True):
            continue
        rate = 100.0 * agg["done"] / agg["n"]
        by_kind.setdefault(kind, []).append((service, rate, agg["n"]))

    suggestions: list[dict[str, Any]] = []
    for kind, peers in sorted(by_kind.items()):
        for service, rate, n in peers:
            others = [r for s, r, _ in peers if s != service]
            if len(others) < CALIBRATE_MIN_PEERS:
                continue
            med = float(statistics.median(others))
            delta = None
            reason = None
            if rate < med - CALIBRATE_SUGGEST_WORSE_BELOW:
                delta = CALIBRATE_SUGGEST_WORSE_DELTA
                reason = (f"done_rate {rate:.1f} is >{CALIBRATE_SUGGEST_WORSE_BELOW:g} "
                          f"points below peer median {med:.1f}")
            elif rate > med + CALIBRATE_SUGGEST_BETTER_ABOVE:
                delta = -CALIBRATE_SUGGEST_BETTER_DELTA
                reason = (f"done_rate {rate:.1f} is >{CALIBRATE_SUGGEST_BETTER_ABOVE:g} "
                          f"points above peer median {med:.1f}")
            if delta is None:
                continue
            suggestions.append({
                "service": service,
                "kind": kind,
                "n": int(n),
                "done_rate": round(rate, 1),
                "peer_median_done_rate": round(med, 1),
                "suggest_rank_delta": delta,
                "reason": reason,
            })
    suggestions.sort(key=lambda s: (s["kind"], s["service"]))

    return {
        "generated_at": now.isoformat(),
        "since_days": since_days,
        "min_n": min_n,
        "in_flight": in_flight,
        "groups": group_rows,
        "suggestions": suggestions,
    }


def format_calibrate_table(report: dict[str, Any]) -> str:
    """Human table for `route_agent.py calibrate` (non-JSON)."""
    lines = [
        f"calibrate: {len(report['groups'])} groups, "
        f"{len(report['suggestions'])} suggestions, "
        f"{report.get('in_flight', 0)} in_flight "
        f"(min n={report['min_n']}"
        + (f", since {report['since_days']}d" if report.get("since_days") else "")
        + ")",
        "",
        (f"{'service':18} {'model':28} {'kind':10} {'done':8} "
         f"{'n':>4} {'nr':>3} {'q':>3} {'usage%':>7}"),
    ]
    for g in report["groups"]:
        done = f"{g['done']}/{g['n']}"
        usage = g["median_measured_usage_pct"]
        usage_s = "—" if usage is None else f"{usage:.1f}"
        lines.append(
            f"{g['service'][:18]:18} {g['model'][:28]:28} {g['kind'][:10]:10} "
            f"{done:8} {g['n']:4d} {g['no_report']:3d} {g['quota_stop']:3d} "
            f"{usage_s:>7}"
        )
    if report["suggestions"]:
        lines += ["", "suggestions:"]
        for s in report["suggestions"]:
            sign = "+" if s["suggest_rank_delta"] > 0 else ""
            lines.append(
                f"  {s['service']} × {s['kind']}: rank {sign}{s['suggest_rank_delta']} "
                f"(done {s['done_rate']}% vs peer median {s['peer_median_done_rate']}%, "
                f"n={s['n']})"
            )
    else:
        lines += ["", "suggestions: (none)"]
    return "\n".join(lines) + "\n"


ADJUST_EXIT_REFUSED = 3


def _adjust_command(args: argparse.Namespace, parser: argparse.ArgumentParser,
                    quota: dict[str, Any], age: float | None) -> int:
    """`adjust`: `plan` with memory. Exit 0 (rows may be queued), 3 when a slice was refused
    (a frontier slice that would have been downgraded, or a never_target pool)."""
    import route_adjust as ra
    cfg = ra.settings(sys.modules[__name__])
    try:
        directory = ra.state_dir()
    except ValueError as e:
        parser.error(str(e))
    if args.status:
        state = ra.load_state(directory / "state.json")
        print(json.dumps({"enabled": cfg["enabled"], "state_dir": str(directory), **state}, indent=1))
        return 0
    if not args.kinds:
        parser.error("adjust needs --kinds (or --status)")
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
    bad = [k for k in kinds if k not in KINDS]
    if bad:
        parser.error(f"unknown kind(s) {bad}; choose from {KINDS}")
    skip = {x.strip() for arg in args.exclude for x in arg.split(",") if x.strip()} | operator_disabled()
    repo = args.repo or repo_of(os.getcwd())
    write = cfg["enabled"] and not args.dry_run
    try:
        with (ra.locked(directory) if write else contextlib.nullcontext()):
            state = ra.load_state(directory / "state.json") if cfg["enabled"] else ra.empty_state()
            result = ra.adjust(sys.modules[__name__], kinds, quota=quota, age=age, state=state,
                               exclude=skip, min_headroom=args.min_headroom, repo=repo, cfg=cfg)
            if write:
                ra.log_events(directory, result["events"])
                ra.save_state(directory / "state.json", result["state"])
    except ra.LockBusy as e:
        # A hung holder must not block launches: plan read-only, record nothing.
        print(f"WARNING: {e}; planning read-only (no hold or restore recorded)", file=sys.stderr)
        result = ra.adjust(sys.modules[__name__], kinds, quota=quota, age=age,
                           state=ra.load_state(directory / "state.json"), exclude=skip,
                           min_headroom=args.min_headroom, repo=repo, cfg=cfg)
    for event in result["events"]:
        print("adjust: " + json.dumps(event, sort_keys=True), file=sys.stderr)
    refused = any(r is not None for _, _, r in result["rows"])
    if args.json:
        print(json.dumps({
            "enabled": cfg["enabled"], "snapshot_age_s": age, "fresh": result["fresh"],
            "canary_pool_max": {p: 1 for p in sorted(CANARY_POOLS)},
            "canary_release": "lead verifies one successful turn before adding agents",
            "held": result["held"], "events": result["events"], "dry_run": args.dry_run,
            "slices": [{"kind": k, "service": c.service.name if c else None,
                        "agent": c.service.acp_agent if c else None,
                        "model": c.model if c else None,
                        "dispatch": c.dispatch if c else None,
                        "remaining": c.remaining if c else None,
                        "refused": refusal,
                        "why": refusal or (c.why if c else unrouted_why(k, quota, skip))}
                       for k, c, refusal in result["rows"]]}, indent=1))
    else:
        for pool in sorted(CANARY_POOLS):
            print(f"canary pool {pool}: max=1; verify one successful turn before adding agents")
        if not result["fresh"] and cfg["enabled"]:
            print("WARNING: quota snapshot empty or older than "
                  f"{cfg['max_age_seconds']:g}s -> no hold or restore changed; run `aiuse --available --live` first",
                  file=sys.stderr)
        for i, (k, c, refusal) in enumerate(result["rows"], 1):
            if refusal:
                print(f"{i}. {k:10} -> REFUSED: {refusal}")
            elif c is None:
                print(f"{i}. {k:10} -> (none: {unrouted_why(k, quota, skip)}; re-plan at the next boundary)")
            else:
                rem = "" if c.remaining is None else f" {c.remaining:.0f}% left"
                print(f"{i}. {k:10} -> {c.service.name}{rem}  [{c.service.cli}]  {c.dispatch}")
        if result["held"]:
            print("held off: " + json.dumps(result["held"], sort_keys=True))
    return ADJUST_EXIT_REFUSED if refused else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Route work to a vendor")
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("route")
    r.add_argument("--kind", required=True, choices=KINDS)
    r.add_argument("--json", action="store_true")
    r.add_argument("--min-headroom", type=float, default=15.0)
    r.add_argument("--repo", help="repository the slice works in, for [dispatch.repo_overrides] (default: the cwd's origin remote)")
    r.add_argument("--brief", help="the slice's brief file (accepted and ignored since 2026-11-06, when the "
                   "Jev shadow ask was removed)")
    pl = sub.add_parser("plan", help="assign a wave of slice kinds to services now")
    pl.add_argument("--kinds", required=True,
                    help="comma list, hardest first, e.g. code,code,research,bulk")
    pl.add_argument("--exclude", action="append", default=[],
                    help="comma list of services to skip (just failed or spent); repeatable. "
                    "aiuse [disabled_services] are always skipped")
    pl.add_argument("--min-headroom", type=float, default=15.0)
    pl.add_argument("--repo", help="repository the slices work in, for [dispatch.repo_overrides] (default: the cwd's origin remote)")
    pl.add_argument("--json", action="store_true")
    pl.add_argument("--brief", action="append", default=[],
                    help="brief file per kind, in --kinds order (repeat; accepted and ignored since 2026-11-06)")
    ad = sub.add_parser("adjust", help="plan a wave like `plan`, but move kinds off a pool that fell below its "
                        "floor and back once it recovers (hysteresis, state and change log; new launches only)")
    ad.add_argument("--kinds", help="comma list, hardest first, e.g. code,code,research,bulk")
    ad.add_argument("--exclude", action="append", default=[], help="comma list of services to skip; repeatable")
    ad.add_argument("--min-headroom", type=float, default=15.0)
    ad.add_argument("--repo", help="repository the slices work in (default: the cwd's origin remote)")
    ad.add_argument("--json", action="store_true")
    ad.add_argument("--dry-run", action="store_true", help="compute and print, but write no state and no log")
    ad.add_argument("--status", action="store_true", help="print the saved holds and exit")
    sub.add_parser("show", help="snapshot age, headroom, pace, expected waste")
    sv = sub.add_parser("services", help="every service discovered right now, with its Paseo provider's status")
    sv.add_argument("--check-models", action="store_true",
                    help="check every curated model suggestion against `paseo provider models <provider> --json`; "
                    "exit 1 when one is not listed, 2 when Paseo cannot list a provider's models")
    hc = sub.add_parser("hermes-chain", help="generate Hermes's provider chain")
    hc.add_argument("--apply", action="store_true", help="write it to config.yaml")
    sb = sub.add_parser(
        "substrate",
        help="main-loop substrate chain (Dann: Flash-primary, cline↔opencode-go failover)",
    )
    sb.add_argument("--json", action="store_true")
    sb.add_argument("--apply", metavar="AGENT", default=None,
                    help="apply the primary to this Paseo agent (within-provider only). "
                    "Exit codes: 0 ok; 1 paseo-set-model failed; 2 empty or ambiguous AGENT; "
                    "3 no such agent; 4 model not applied; 5 cross-provider (start a new session); "
                    "6 no usable substrate (also without --apply); 7 cannot list agents")
    pol = sub.add_parser("policy", help="print the effective routing policy")
    pol.add_argument("--md", action="store_true",
                     help="markdown tables (services × kinds, gates, caps)")
    cal = sub.add_parser(
        "calibrate",
        help="dispatch outcome report + suggested good_at rank changes",
    )
    cal.add_argument("--since", type=float, default=None, metavar="DAYS",
                     help="only records finished/started within the last DAYS")
    cal.add_argument("--json", action="store_true",
                     help="stable JSON for the monthly AI re-rank job")
    cal.add_argument("--min", type=int, default=None, metavar="N",
                     help="minimum n for suggestions "
                     f"(default [calibrate].min_outcomes={CALIBRATE_MIN_OUTCOMES})")

    args = parser.parse_args(argv)
    if args.command == "calibrate":
        # No snapshot needed; avoid a stale-hard wipe delaying the report.
        report = calibrate_report(since_days=args.since, min_n=args.min)
        if args.json:
            print(json.dumps(report, indent=2, sort_keys=True))
        else:
            print(format_calibrate_table(report))
        return 0

    quota, age = load_snapshot()

    if args.command == "plan":
        kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
        bad = [k for k in kinds if k not in KINDS]
        if bad:
            parser.error(f"unknown kind(s) {bad}; choose from {KINDS}")
        skip = {x.strip() for arg in args.exclude for x in arg.split(",") if x.strip()}
        skip |= operator_disabled()
        rows = plan(kinds, quota=quota, min_headroom=args.min_headroom, exclude=skip,
                    repo=(args.repo or repo_of(os.getcwd())))
        if args.brief and len(args.brief) != len(kinds):
            parser.error("--brief must be given once per kind, in --kinds order")
        stale = (not quota) or age is None or age > STALE_SOFT
        if args.json:
            print(json.dumps({
                "snapshot_age_s": age, "stale": stale,
                "quota_source": quota_source_info(),
                "canary_pool_max": {p: 1 for p in sorted(CANARY_POOLS)},
                "canary_release": "lead verifies one successful turn before adding agents",
                "slices": [{"kind": k, "service": c.service.name if c else None,
                            "cli": c.service.cli if c else None,
                            "agent": c.service.acp_agent if c else None,
                            "model": c.model if c else None,
                            "dispatch": c.dispatch if c else None,
                            "remaining": c.remaining if c else None,
                            "why": c.why if c else unrouted_why(k, quota, skip)}
                           for k, c in rows]}, indent=1))
        else:
            for pool in sorted(CANARY_POOLS):
                print(f"canary pool {pool}: max=1; verify one successful turn before adding agents")
            if QuotaSource.fallback_reason:
                print(f"WARNING: {QuotaSource.fallback_reason}; quota below is from the "
                      "snapshot file and misses aiuse's credits override and Admin API "
                      "readings", file=sys.stderr)
            if stale:
                print("WARNING: quota snapshot "
                      + ("empty" if not quota else f"{(age or 0) / 60:.0f} min old")
                      + " -> run `aiuse --available --live` first; routing below "
                      "is capability-only for unmeasured pools", file=sys.stderr)
            for i, (k, c) in enumerate(rows, 1):
                if c is None:
                    print(f"{i}. {k:10} -> (none: {unrouted_why(k, quota, skip)}; "
                          "re-plan at the next boundary)")
                else:
                    rem = "" if c.remaining is None else f" {c.remaining:.0f}% left"
                    print(f"{i}. {k:10} -> {c.service.name}{rem}  [{c.service.cli}]"
                          f"  {c.dispatch}")
        return 0

    if args.command == "adjust":
        return _adjust_command(args, parser, quota, age)

    if args.command == "show":
        import quota_nudge
        quota_nudge.print_reminder(quota)
        print(f"quota source: {quota_source_info()['source']}"
              + (f" (aiuse unavailable: {QuotaSource.fallback_reason})"
                 if QuotaSource.fallback_reason else ""))
        print(f"snapshot: {SNAPSHOT}")
        print(f"paseo usage: {QuotaSource.paseo or 'not read'}")
        print(f"age: {'absent' if age is None else f'{age / 60:.1f} min'}"
              f"  (refreshed by launchd com.djbclark.aiuse every 15 min)")
        for name, info in sorted(quota.items(),
                                 key=lambda kv: (kv[1].get("remaining") is None,
                                                 kv[1].get("remaining") or 0)):
            svc = BY_NAME.get(name)
            flag = "" if not svc else ("  [retired]" if svc.retired else
                                       "  [never-bulk]" if svc.never_bulk else "")
            rem = info.get("remaining")
            pace = info.get("pace_ratio")
            hrs = hours_to_reset(info.get("resets_at"))
            waste = expected_waste(rem, pace, info.get("resets_at"),
                                   info.get("window_minutes"))
            if waste is None and svc and svc.grant_days:
                waste = grant_waste(rem, info.get("resets_at"), svc.grant_days)
            extra = []
            if pace is not None:
                try:
                    extra.append(f"pace {float(pace):.2f}×")
                except (ValueError, TypeError):
                    pass
            if hrs is not None:
                extra.append(f"reset in {hrs:.1f}h")
            if waste is not None:
                extra.append(f"waste≈{waste:.0f}%")
            src = QuotaSource.pools.get(name)
            if src:
                extra.append(f"from {src}")
            if info.get("unknown") or info.get("paseo_unknown"):
                extra.append(str(info.get("unknown") or info.get("paseo_unknown")))
            trail = ("  " + ", ".join(extra)) if extra else ""
            print(f"  {name:16} {rem!s:>6}% remaining{trail}{flag}")
        return 0

    if args.command == "hermes-chain":
        chain = hermes_chain(quota)
        for i, e in enumerate(chain):
            role = "primary" if i == 0 else f"fallback {i}"
            rem = (quota.get(e["_pool"]) or {}).get("remaining")
            print(f"  {role:11} {e['provider']}/{e['model']:32} "
                  f"{e['_billing']:12} {'' if rem is None else f'{rem:.0f}% left'}")
        excluded = [s for s in SERVICES if s.access != "api" and not s.retired]
        print(f"\n  excluded ({len(excluded)}): "
              + ", ".join(f"{s.name}[{s.access}]" for s in excluded))
        if args.apply:
            print("\n  backup:", apply_hermes_chain(chain))
        return 0

    if args.command == "substrate":
        accounts, file_age = _read_snapshot_file()
        chain = substrate_chain(quota, accounts, file_age=file_age)
        usable = any(e["usable"] for e in chain)
        if args.json:
            doc: dict[str, Any] = {"snapshot_age_s": age, "usable": usable, "chain": chain}
            if not usable:
                doc["error"] = "no usable substrate"
            print(json.dumps(doc, indent=2))
            if not usable:
                print("no usable substrate", file=sys.stderr)
        else:
            for e in chain:
                rem = e["remaining"]
                remtxt = "unmeasured" if rem is None else f"{rem:.0f}% left"
                mon = e.get("monthly")
                montxt = "" if mon is None else f"  (monthly {mon:.0f}%)"
                flag = "" if e["usable"] else "  [EXHAUSTED]"
                print(f"  {e['role']:9} {e['provider']}/{e['model']:34} {remtxt}{montxt}{flag}")
            print("\n  primary→fallback is a PROVIDER failover at session start, not a live")
            print("  switch: Paseo binds one provider per session (set_agent_model refuses a")
            print("  cross-provider change), so a new session starts on the other provider")
            print("  with the SAME model.")
            if not usable:
                print("no usable substrate")
        if not usable:
            return SUBSTRATE_EXIT_NONE_USABLE
        if args.apply:
            rc, msg = apply_substrate(args.apply, chain)
            print("\n  apply:", msg, file=sys.stderr if args.json else sys.stdout)
            return rc
        return 0

    if args.command == "policy":
        if args.md:
            sys.stdout.write(policy_markdown())
        else:
            print(json.dumps(policy_public(), indent=2))
        return 0

    if args.command == "services":
        found = discover(quota)
        curated = {s.name for s in SERVICES}
        rows = {r["provider"]: r for r in paseo_provider_rows()}
        print(f"{len(found)} services discovered "
              f"({len(curated & {s.name for s in found})} curated, "
              f"{len(found) - len(curated & {s.name for s in found})} auto)")
        for svc in sorted(found, key=lambda s: s.name):
            kinds = ",".join(sorted(svc.good_at))
            mark = " " if svc.name in curated else "*"
            row = rows.get(svc.acp_agent)
            status = ("paseo: ?" if not rows else "paseo: not listed" if row is None
                      else f"paseo: {row.get('status')}" + ("" if row.get("enabled") == "Enabled" else ", disabled"))
            print(f" {mark}{svc.name:22} {kinds[:44]:44} {svc.billing:12} {status}")
        print(" * = discovered without a curated profile; paseo: the provider's `paseo provider ls` status "
              "(? = Paseo not readable)")
        if not args.check_models:
            return 0
        missing = unreadable = False
        for svc in sorted(SERVICES, key=lambda s: s.name):
            if svc.retired or svc.access == "api" or svc.name == "cursor-cloud" or not svc.models:
                continue                    # api pools and Cursor Cloud are not Paseo providers
            listed = provider_models(svc.acp_agent)
            for kind, spec in sorted(svc.models.items()):
                model = spec.split()[0]
                if listed is None:
                    print(f"  ? {svc.name} {kind}: {model} (paseo provider models {svc.acp_agent} unreadable)")
                    unreadable = True
                elif model not in listed and f"{svc.acp_agent}/{model}" not in listed:
                    print(f"  MISSING {svc.name} {kind}: {model} is not in `paseo provider models {svc.acp_agent}`")
                    missing = True
        if not (missing or unreadable):
            print("  every suggested model is listed by its Paseo provider")
        return 1 if missing else 2 if unreadable else 0

    choice = route(args.kind, quota=quota, min_headroom=args.min_headroom, exclude=operator_disabled(),
                   repo=(args.repo or repo_of(os.getcwd())))
    if choice is None:
        print(json.dumps({"kind": args.kind, "service": None,
                          "reason": "no eligible service with headroom"}))
        return 1
    if args.json:
        print(json.dumps({
            "kind": args.kind, "service": choice.service.name, "cli": choice.service.cli,
            "agent": choice.service.acp_agent, "model": choice.model,
            "dispatch": choice.dispatch,
            "remaining_percent": choice.remaining, "why": choice.why,
            "alternatives": choice.alternatives,
            "snapshot_age_seconds": None if age is None else round(age),
            "quota_source": quota_source_info(),
        }, indent=2))
    else:
        print(f"{choice.service.cli}   — {choice.why}")
        print(f"  dispatch: {choice.dispatch}")
        if choice.alternatives:
            print(f"  alternatives: {', '.join(choice.alternatives)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
