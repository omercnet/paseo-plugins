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
    accountKey: "anthropic-account",
    limitId: "five-hour",
    email: null,
    accountId: null,
    accountHost: null,
    label: "Claude 5 Hour",
    windowLabel: "5 Hour",
    usedFraction: 0.25,
    status: "ok",
    resetsAt: null,
    recordedAt: 1,
  },
  {
    provider: "cursor",
    accountKey: "cursor-account",
    limitId: "pro",
    email: null,
    accountId: null,
    accountHost: null,
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
  test("groups quota rows by account identity and keeps limits together", () => {
    const accountRows: OmpQuota[] = [
      {
        ...quotas[0],
        accountKey: "team-a",
        limitId: "five-hour",
        email: "team@example.com",
        label: "Usage",
        usedFraction: 0.25,
      },
      {
        ...quotas[0],
        accountKey: "team-a",
        limitId: "weekly",
        email: "team@example.com",
        label: "Usage",
        usedFraction: 0.5,
      },
      {
        ...quotas[0],
        accountKey: "team-b",
        limitId: "five-hour",
        email: "team@example.com",
        label: "Usage",
        usedFraction: 0.9,
      },
      { ...quotas[0], accountKey: "unknown-a", limitId: "daily", email: null, usedFraction: 0.7 },
      { ...quotas[0], accountKey: "unknown-b", limitId: "session", email: null, usedFraction: 0.1 },
    ];
    const groups = quotaProviderGroups(accountRows, null);
    const accounts = groups[0].accounts;

    expect(accounts).toHaveLength(4);
    expect(accounts.filter((account) => account.email === "team@example.com")).toHaveLength(2);
    expect(accounts.filter((account) => account.email === null)).toHaveLength(2);
    expect(
      accounts
        .find((account) => account.accountKey === "team-a")
        ?.quotas.map((quota) => quota.limitId),
    ).toEqual(["weekly", "five-hour"]);
    expect(
      accounts.map(({ accountKey, label, peakFraction }) => ({ accountKey, label, peakFraction })),
    ).toEqual([
      { accountKey: "team-b", label: "team@example.com · Account 1", peakFraction: 0.9 },
      { accountKey: "unknown-a", label: "Account 1", peakFraction: 0.7 },
      { accountKey: "team-a", label: "team@example.com · Account 2", peakFraction: 0.5 },
      { accountKey: "unknown-b", label: "Account 2", peakFraction: 0.1 },
    ]);
  });

  test("uses identifiers from any account window and prefers email over account ID", () => {
    const rows: OmpQuota[] = [
      { ...quotas[0], accountKey: "email-account", usedFraction: 0.9 },
      {
        ...quotas[0],
        accountKey: "email-account",
        limitId: "weekly",
        email: " ",
        accountId: "fallback-user",
        usedFraction: 0.3,
      },
      {
        ...quotas[0],
        accountKey: "email-account",
        limitId: "monthly",
        email: "team@example.com",
        usedFraction: 0.2,
      },
      { ...quotas[0], accountKey: "id-account", usedFraction: 0.8 },
      {
        ...quotas[0],
        accountKey: "id-account",
        limitId: "weekly",
        accountId: "recorded-user",
        usedFraction: 0.1,
      },
    ];
    expect(
      quotaProviderGroups(rows, null)[0].accounts.map(({ email, label }) => ({ email, label })),
    ).toEqual([
      { email: "team@example.com", label: "team@example.com" },
      { email: null, label: "recorded-user" },
    ]);
  });

  test("omits a redundant heading for a single unnamed account", () => {
    expect(quotaProviderGroups([quotas[0]], null)[0].accounts[0].label).toBeNull();
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
          accountKey: "anthropic-account",
          limitId: "five-hour",
          label: "Claude 5 Hour",
          email: null,
          accountId: null,
          accountHost: null,
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
  test("shows Copilot usernames and distinguishes GitHub from the recorded GHE host", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-copilot-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, email TEXT, account_id TEXT,
      limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT,
      resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    const insert = database.prepare(
      "INSERT INTO usage_history VALUES (?, 'github-copilot', ?, ?, ?, 'premium', 'Premium Requests', 'Monthly', 0.1, 'ok', NULL, ?)",
    );
    insert.run(1, "oauth|account:sample", null, "sample", now);
    insert.run(
      2,
      "oauth|account:sample|enterprise:enterprise.example.invalid",
      null,
      "sample",
      now,
    );
    insert.run(3, "oauth|enterprise:https://other.example.invalid", " ", "other", now);
    insert.run(4, "legacy-key", "owner@example.com", "ignored", now);
    insert.run(
      5,
      "oauth|enterprise:https://placeholder@invalid.example.invalid",
      null,
      "unsafe",
      now,
    );
    database.close();

    const recorded = listOmpQuotasFrom(path, now);
    const accounts = quotaProviderGroups(recorded, "github-copilot")[0].accounts;
    expect(recorded.every((quota) => quota.accountId !== null)).toBe(true);
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringMatching(/^sample · Account [12]$/u),
          accountHost: "github.com",
        }),
        expect.objectContaining({
          label: expect.stringMatching(/^sample · Account [12]$/u),
          accountHost: "enterprise.example.invalid",
        }),
        expect.objectContaining({ label: "other", accountHost: "other.example.invalid" }),
        expect.objectContaining({ label: "owner@example.com", accountHost: null }),
        expect.objectContaining({ label: "unsafe", accountHost: null }),
      ]),
    );
    expect(
      accounts
        .filter((account) => account.label?.startsWith("sample · "))
        .map(({ label }) => label),
    ).toEqual(["sample · Account 1", "sample · Account 2"]);
  });

  test("keeps opaque account identities stable without exposing OMP key components", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-key-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    const key =
      "oauth|org:example-org|project:example-project|enterprise:enterprise.example.invalid|secret:synthetic-fingerprint";
    const insert = database.prepare(
      "INSERT INTO usage_history VALUES (?, 'github-copilot', ?, ?, 'Usage', NULL, 0.1, 'ok', NULL, ?)",
    );
    insert.run(1, key, "first", now);
    insert.run(2, key, "second", now);
    insert.run(3, `${key}-other`, "third", now);
    database.close();

    const recorded = listOmpQuotasFrom(path, now);
    expect(recorded.map(({ limitId }) => limitId)).toEqual(["first", "second", "third"]);
    const [first, second, third] = recorded;
    expect(first.accountKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.accountKey).toBe(second.accountKey);
    expect(first.accountKey).not.toBe(third.accountKey);
    expect(first.accountKey).not.toContain("example-org");
    expect(first.accountKey).not.toContain("example-project");
    expect(first.accountKey).not.toContain("synthetic-fingerprint");
    expect(first.accountHost).toBe("enterprise.example.invalid");
    expect(listOmpQuotasFrom(path, now).map(({ accountKey }) => accountKey)).toEqual(
      recorded.map(({ accountKey }) => accountKey),
    );
  });

  test.each([
    { name: "email only", columns: "email TEXT,", email: "saved@example.com", accountId: null },
    { name: "account ID only", columns: "account_id TEXT,", email: null, accountId: "saved-user" },
    { name: "neither identifier", columns: "", email: null, accountId: null },
  ])("reads legacy quota tables with $name", async ({ columns, email, accountId }) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-legacy-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, ${columns}
      limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT,
      resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    database
      .prepare(
        "INSERT INTO usage_history (id, provider, account_key, limit_id, label, used_fraction, recorded_at) VALUES (1, 'github-copilot', 'legacy-account', 'premium', 'Premium Requests', 0.1, ?)",
      )
      .run(now);
    if (email) database.prepare("UPDATE usage_history SET email = ?").run(email);
    if (accountId) database.prepare("UPDATE usage_history SET account_id = ?").run(accountId);
    database.close();

    const recorded = listOmpQuotasFrom(path, now);
    expect(recorded).toEqual([
      expect.objectContaining({ email, accountId, accountHost: null, label: "Premium Requests" }),
    ]);
    expect(quotaProviderGroups(recorded, null)[0].accounts[0].label).toBe(email ?? accountId);
  });

  test("keeps the newest valid quota row per provider account and limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quotas-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, email TEXT DEFAULT NULL,
      limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT,
      resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    const insert = database.prepare(
      "INSERT INTO usage_history (id, provider, account_key, email, limit_id, label, window_label, used_fraction, status, resets_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      1,
      "anthropic",
      "account",
      "team@example.com",
      "five-hour",
      "Five hour",
      "5h",
      0.1,
      "ok",
      null,
      now - 3,
    );
    insert.run(
      2,
      "anthropic",
      "account",
      "team@example.com",
      "five-hour",
      "Five hour",
      "5h",
      0.9,
      "warning",
      now + 60_000,
      now - 2,
    );
    insert.run(3, "openai", "account", null, "daily", "Daily", null, 0.2, "ok", null, now - 1);
    insert.run(
      4,
      "anthropic",
      "other-account",
      "personal@example.com",
      "five-hour",
      "Five hour",
      "5h",
      0.4,
      "ok",
      now + 60_000,
      now - 1,
    );
    insert.run(
      5,
      "anthropic",
      "other-team-account",
      "team@example.com",
      "weekly",
      "Weekly",
      "7d",
      0.15,
      "ok",
      now + 60_000,
      now,
    );
    insert.run(
      6,
      "openai",
      "other-unknown-account",
      null,
      "session",
      "Session",
      null,
      0.1,
      "ok",
      null,
      now,
    );
    database.close();

    expect(listOmpQuotasFrom(path, now)).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        accountKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        email: "team@example.com",
        usedFraction: 0.9,
        recordedAt: now - 2,
      }),
      expect.objectContaining({
        provider: "anthropic",
        accountKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        email: "personal@example.com",
        usedFraction: 0.4,
        recordedAt: now - 1,
      }),
      expect.objectContaining({
        provider: "openai",
        accountKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        email: null,
        usedFraction: 0.2,
        recordedAt: now - 1,
      }),
      expect.objectContaining({
        provider: "anthropic",
        accountKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        email: "team@example.com",
        usedFraction: 0.15,
        recordedAt: now,
      }),
      expect.objectContaining({
        provider: "openai",
        accountKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
        email: null,
        usedFraction: 0.1,
        recordedAt: now,
      }),
    ]);
    expect(listOmpQuotasFrom(join(root, "missing.db"))).toEqual([]);
  });

  test("drops windows that already reset and reset-less rows abandoned for over 30 days", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quotas-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, email TEXT DEFAULT NULL,
      limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT,
      resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    const day = 86_400_000;
    const insert = database.prepare(
      "INSERT INTO usage_history (id, provider, account_key, limit_id, label, window_label, used_fraction, status, resets_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, email TEXT DEFAULT NULL,
      limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT,
      resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = 1_800_000_000_000;
    const window = 30 * 86_400_000;
    const insert = database.prepare(
      "INSERT INTO usage_history (id, provider, account_key, limit_id, label, window_label, used_fraction, status, resets_at, recorded_at) VALUES (?, 'p', 'a', ?, ?, NULL, ?, NULL, ?, ?)",
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
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, email TEXT DEFAULT NULL,
      limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT,
      resets_at INTEGER, recorded_at INTEGER
    )`);
    database
      .prepare(
        "INSERT INTO usage_history (id, provider, account_key, limit_id, label, window_label, used_fraction, status, resets_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
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
