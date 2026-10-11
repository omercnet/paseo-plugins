import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  quotaDetailLabel,
  quotaProviderFromSession,
  quotaProviderGroups,
  quotaProviderIconName,
  quotaRecordedLabel,
  quotaResetLabel,
  quotaSeverityForProvider,
  quotaSummaryForProvider,
  quotasForProvider,
} from "../client/quota-state";
import { listOmpQuotasFrom, resolveListOmpQuotas } from "../server/quota";
import type { OmpQuota } from "../shared/quota";

const quotaRoots: string[] = [];

afterEach(async () => {
  await Promise.all(quotaRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const quotas: OmpQuota[] = [
  {
    provider: "anthropic",
    label: "Claude 5 Hour",
    windowLabel: "5 Hour",
    usedFraction: 0.25,
    status: "ok",
    resetsAt: null,
    recordedAt: 1,
  },
  {
    provider: "cursor",
    label: "Cursor Pro",
    windowLabel: null,
    usedFraction: 0.9,
    status: "ok",
    resetsAt: null,
    recordedAt: 1,
  },
];

describe("session-specific quota selection", () => {
  test("derives the omp model provider from Paseo's provider string", () => {
    expect(quotaProviderFromSession("omp/anthropic/claude-opus-5")).toBe("anthropic");
    expect(quotaProviderFromSession("omp", "azure/gpt-5.6-terra")).toBe("azure");
    expect(quotaProviderFromSession("codex/gpt-5.4")).toBeNull();
  });
  test("shows only the current session provider quota", () => {
    expect(quotasForProvider(quotas, "anthropic")).toEqual([quotas[0]]);
    expect(quotaSummaryForProvider(quotas, "anthropic")).toEqual({
      visible: true,
      label: "Anthropic · 25%",
    });
    expect(quotaSummaryForProvider(quotas, "azure")).toEqual({
      visible: true,
      label: "Azure · —",
    });
  });

  test("maps each provider to a distinct icon and severity bucket", () => {
    expect(quotaProviderIconName("anthropic")).toBe("Asterisk");
    expect(quotaProviderIconName("cursor")).toBe("MousePointer2");
    expect(quotaProviderIconName("azure")).toBe("Cloud");
    expect(quotaProviderIconName("unknown-vendor")).toBe("Gauge");
    expect(quotaSeverityForProvider(quotas, "anthropic")).toBe("ok");
    expect(quotaSeverityForProvider(quotas, "cursor")).toBe("danger");
    expect(quotaSeverityForProvider(quotas, "azure")).toBe("unknown");
  });

  test("sorts the active session's provider first, then worst quota first", () => {
    const groups = quotaProviderGroups(quotas, "azure");
    expect(groups.map((group) => group.provider)).toEqual(["cursor", "anthropic"]);
    expect(groups[0]).toMatchObject({ provider: "cursor", peakFraction: 0.9, severity: "danger" });

    const currentFirst = quotaProviderGroups(quotas, "anthropic");
    expect(currentFirst.map((group) => group.provider)).toEqual(["anthropic", "cursor"]);
  });
});

describe("quota timestamps", () => {
  test("labels recorded quota snapshots", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(quotaRecordedLabel(now, now)).toBe("Recorded just now");
    expect(quotaRecordedLabel(now - 2 * 3_600_000, now)).toBe("Recorded 2h ago");
    expect(
      quotaDetailLabel(
        {
          provider: "anthropic",
          label: "Claude 5 Hour",
          windowLabel: "5 Hour",
          usedFraction: 0.25,
          status: "ok",
          recordedAt: now - 2 * 3_600_000,
          resetsAt: now + 30 * 60_000,
        },
        now,
      ),
    ).toBe("5 Hour · resets 30m · Recorded 2h ago");
  });
});

describe("quota reset countdown", () => {
  test("treats resets_at as epoch milliseconds, not seconds", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const resetsInTwoHours = now + 2 * 3_600_000 + 30 * 60_000;
    expect(quotaResetLabel(resetsInTwoHours, now)).toBe("resets 2h 30m");
    expect(quotaResetLabel(now - 1_000, now)).toBe("resets 0m");
    expect(quotaResetLabel(null, now)).toBe("");
  });
});

describe("OMP quota reader", () => {
  test("keeps the newest valid quota row per provider account and limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quotas-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    const insert = database.prepare(
      "INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(1, "anthropic", "account", "five-hour", "Five hour", "5h", 0.1, "ok", null, now - 3);
    insert.run(
      2,
      "anthropic",
      "account",
      "five-hour",
      "Five hour",
      "5h",
      0.9,
      "warning",
      now + 60_000,
      now - 2,
    );
    insert.run(3, "openai", "account", "daily", "Daily", null, 0.2, "ok", null, now - 1);
    database.close();

    expect(listOmpQuotasFrom(path, now)).toEqual([
      expect.objectContaining({ provider: "anthropic", usedFraction: 0.9, recordedAt: now - 2 }),
      expect.objectContaining({ provider: "openai", usedFraction: 0.2, recordedAt: now - 1 }),
    ]);
    expect(listOmpQuotasFrom(join(root, "missing.db"))).toEqual([]);
  });

  test("drops windows that already reset and reset-less rows abandoned for over 30 days", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quotas-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    const day = 86_400_000;
    const insert = database.prepare(
      "INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      1,
      "cursor",
      "old",
      "other",
      "Exhausted",
      null,
      1,
      "exhausted",
      now - 40 * day,
      now - 41 * day,
    );
    insert.run(
      2,
      "anthropic",
      "acct",
      "5h",
      "Live",
      "5h",
      0.2,
      "ok",
      now + 3_600_000,
      now - 60_000,
    );
    insert.run(3, "openai", "acct", "idle", "Idle", null, 0.9, null, null, now - 31 * day);
    insert.run(4, "openai", "acct", "active", "Active", null, 0.1, null, null, now - 29 * day);
    database.close();

    expect(listOmpQuotasFrom(path, now).map((quota) => quota.label)).toEqual(["Live", "Active"]);
  });

  test("judges only the newest row of a series and drops exact boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quotas-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = 1_800_000_000_000;
    const window = 30 * 86_400_000;
    const insert = database.prepare(
      "INSERT INTO usage_history VALUES (?, 'p', 'a', ?, ?, NULL, ?, NULL, ?, ?)",
    );
    // Older live row must not resurrect a series whose newest row already reset.
    insert.run(1, "dead", "Dead", 0.1, now + 1_000, now - 2_000);
    insert.run(2, "dead", "Dead", 0.2, now - 1, now - 1_000);
    // Newest live row wins over an older expired one.
    insert.run(3, "revived", "Revived", 0.3, now - 5_000, now - 4_000);
    insert.run(4, "revived", "Revived", 0.4, now + 1_000, now - 3_000);
    insert.run(5, "reset-at-now", "ResetAtNow", 0.5, now, now - 1);
    insert.run(6, "reset-after-now", "ResetAfterNow", 0.6, now + 1, now - 1);
    insert.run(7, "recorded-at-cutoff", "RecordedAtCutoff", 0.7, null, now - window);
    insert.run(8, "recorded-after-cutoff", "RecordedAfterCutoff", 0.8, null, now - window + 1);
    database.close();

    expect(listOmpQuotasFrom(path, now).map((quota) => quota.label)).toEqual([
      "RecordedAfterCutoff",
      "ResetAfterNow",
      "Revived",
    ]);
  });

  test("resolves quotas from the configured OMP agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quota-resolver-"));
    quotaRoots.push(root);
    const database = new DatabaseSync(join(root, "agent.db"));
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    database
      .prepare("INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(1, "anthropic", "account", "daily", "Daily", null, 0.5, "ok", null, Date.now() - 10);
    database.close();
    const previous = process.env.PASEO_OMP_AGENT_DIR;
    process.env.PASEO_OMP_AGENT_DIR = root;
    try {
      expect(resolveListOmpQuotas({})).toEqual({
        quotas: [expect.objectContaining({ provider: "anthropic", usedFraction: 0.5 })],
      });
    } finally {
      if (previous === undefined) delete process.env.PASEO_OMP_AGENT_DIR;
      else process.env.PASEO_OMP_AGENT_DIR = previous;
    }
  });
});

describe("profile alias and opaque-model quotas", () => {
  test("recognizes native and profile plugin model providers without guessing opaque ids", () => {
    expect(quotaProviderFromSession("omp-plugin", "anthropic/claude-fable-5")).toBe("anthropic");
    expect(quotaProviderFromSession("omp-plugin-team-beta", "openai-codex/gpt-5.6-sol")).toBe(
      "openai-codex",
    );
    expect(quotaProviderFromSession("omp-plugin-team-beta", "omp:model:opaque-hash")).toBeNull();
  });
  test("opaque OMP models retain an explicitly aggregate quota pill", () => {
    expect(quotaSummaryForProvider(quotas, null, true)).toEqual({
      visible: true,
      label: "Quotas · 90%",
    });
    expect(quotaSeverityForProvider(quotas, null, true)).toBe("danger");
    expect(quotaSummaryForProvider([], null, true)).toEqual({ visible: true, label: "Quotas · —" });
    expect(quotaSummaryForProvider(quotas, null).visible).toBe(false);
  });
});
