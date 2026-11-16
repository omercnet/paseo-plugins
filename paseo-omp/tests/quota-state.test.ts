import { createHash } from "node:crypto";
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
  quotaSessionAccounts,
  quotaSeverityForProvider,
  quotaSummaryForProvider,
  quotasForProvider,
  sessionPinCommand,
} from "../client/quota-state";
import { OmpRpcRequestRejectedError } from "../server/provider/omp-rpc-transport";
import {
  listOmpQuotasFrom,
  resolveListOmpQuotas,
  resolveListOmpSessionAccounts,
} from "../server/quota";
import { OmpSubagentControlRegistry, type OmpSubagentControls } from "../server/subagents";
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
    accountService: null,
    accountHost: null,
    plan: null,
    organization: null,
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
    accountService: null,
    accountHost: null,
    plan: null,
    organization: null,
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
      label: "25%",
      title: "Anthropic · all accounts · 25% (last recorded usage, not live)",
    });
    expect(quotaSummaryForProvider(quotas, "azure")).toMatchObject({ visible: true, label: "—" });
  });

  test("summarizes the account in use, not the provider's busiest account", () => {
    const rows: OmpQuota[] = [
      { ...quotas[0], accountKey: "spent", usedFraction: 1 },
      { ...quotas[0], accountKey: "working", usedFraction: 0.19 },
    ];
    const working = {
      credentialId: 5,
      label: "me@example.invalid (Team)",
      active: true,
      quotaAccountKeys: ["working"],
    };

    expect(quotaSummaryForProvider(rows, "anthropic", false, working)).toEqual({
      visible: true,
      label: "19%",
      title: "Anthropic · me@example.invalid (Team) · 19% (last recorded usage, not live)",
    });
    expect(quotaSeverityForProvider(rows, "anthropic", false, working)).toBe("ok");
    // Without an account in use, or with no recorded usage for it, the provider's peak stands.
    expect(quotaSummaryForProvider(rows, "anthropic").label).toBe("100%");
    expect(
      quotaSummaryForProvider(rows, "anthropic", false, { ...working, quotaAccountKeys: [] }).label,
    ).toBe("100%");
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
      accounts.map(({ accountKey, label, suffix, peakFraction }) => ({
        accountKey,
        label,
        suffix,
        peakFraction,
      })),
    ).toEqual([
      { accountKey: "team-b", label: "team@example.com", suffix: "Account 2", peakFraction: 0.9 },
      { accountKey: "unknown-a", label: "Account 1", suffix: null, peakFraction: 0.7 },
      { accountKey: "team-a", label: "team@example.com", suffix: "Account 1", peakFraction: 0.5 },
      { accountKey: "unknown-b", label: "Account 2", suffix: null, peakFraction: 0.1 },
    ]);
  });

  test("uses a non-empty email from any account window", () => {
    const rows: OmpQuota[] = [
      { ...quotas[0], accountKey: "email-account", usedFraction: 0.9 },
      {
        ...quotas[0],
        accountKey: "email-account",
        limitId: "weekly",
        email: " ",
        usedFraction: 0.3,
      },
      {
        ...quotas[0],
        accountKey: "email-account",
        limitId: "monthly",
        email: "team@example.com",
        usedFraction: 0.2,
      },
    ];
    expect(
      quotaProviderGroups(rows, null)[0].accounts.map(({ email, label }) => ({ email, label })),
    ).toEqual([{ email: "team@example.com", label: "team@example.com" }]);
  });

  test("keeps unnamed account numbers stable when peak usage changes", () => {
    const rows = [
      { ...quotas[0], accountKey: "a", usedFraction: 0.9 },
      { ...quotas[0], accountKey: "b", usedFraction: 0.1 },
    ];
    const before = quotaProviderGroups(rows, null)[0].accounts;
    const after = quotaProviderGroups(
      rows.map((row) => ({ ...row, usedFraction: row.accountKey === "a" ? 0.1 : 0.9 })),
      null,
    )[0].accounts;
    expect(before.map(({ accountKey, label }) => [accountKey, label])).toEqual([
      ["a", "Account 1"],
      ["b", "Account 2"],
    ]);
    expect(after.map(({ accountKey, label }) => [accountKey, label])).toEqual([
      ["b", "Account 2"],
      ["a", "Account 1"],
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
          accountService: null,
          accountHost: null,
          plan: null,
          organization: null,
          usedFraction: 0.25,
          windowLabel: "5 Hour",
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

  test("shows days and hours once a reset is a day or more away", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const at = (hours: number, minutes = 0) => now + hours * 3_600_000 + minutes * 60_000;
    expect(quotaResetLabel(at(23, 59), now)).toBe("resets 23h 59m");
    expect(quotaResetLabel(at(24), now)).toBe("resets 1d 0h");
    expect(quotaResetLabel(at(357, 52), now)).toBe("resets 14d 21h");
  });
});

describe("OMP quota reader", () => {
  test("tags accounts with the plan and organization from OMP's cached usage reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-tags-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, email TEXT,
      limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT,
      resets_at INTEGER, recorded_at INTEGER
    );
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)`);
    const now = Date.now();
    const usage = database.prepare(
      "INSERT INTO usage_history VALUES (?, ?, ?, ?, 'weekly', 'Weekly', NULL, 0.1, 'ok', NULL, ?)",
    );
    usage.run(
      1,
      "openai-codex",
      "oauth|account:a|email:team@example.invalid",
      "team@example.invalid",
      now,
    );
    usage.run(
      2,
      "openai-codex",
      "oauth|account:b|email:me@example.invalid",
      "me@example.invalid",
      now,
    );
    usage.run(
      3,
      "anthropic",
      "oauth|account:c|email:me@example.invalid",
      "me@example.invalid",
      now,
    );
    usage.run(
      4,
      "anthropic",
      "oauth|account:d|email:work@example.invalid",
      "work@example.invalid",
      now,
    );
    usage.run(5, "xai-oauth", "oauth|account:e", null, now);
    const cache = database.prepare("INSERT INTO cache VALUES (?, ?, NULL)");
    const report = (provider: string, fetchedAt: number, metadata: object) =>
      JSON.stringify({ expiresAt: 0, value: { provider, fetchedAt, limits: [], metadata } });
    cache.run(
      "usage_cache:report:1:openai-codex:https://example.invalid/api:oauth|account:a|email:team@example.invalid",
      report("openai-codex", 2, {
        planType: "self_serve_business_prolite",
        orgName: "self_serve_business_prolite",
      }),
    );
    cache.run(
      "usage_cache:report:0:openai-codex:default:oauth|account:a|email:team@example.invalid",
      report("openai-codex", 1, { planType: "plus" }),
    );
    cache.run(
      "usage_cache:report:1:openai-codex:default:oauth|account:b|email:me@example.invalid",
      report("openai-codex", 1, { planType: "prolite", orgName: "prolite" }),
    );
    cache.run(
      "usage_cache:report:3:anthropic:default:oauth|account:c|email:me@example.invalid",
      report("anthropic", 1, { orgName: "me@example.invalid's Organization" }),
    );
    cache.run(
      "usage_cache:report:3:anthropic:default:oauth|account:d|email:work@example.invalid",
      report("anthropic", 1, { orgName: "Example Team" }),
    );
    // Another provider's report under the same key suffix, and an unreadable one, are ignored.
    cache.run(
      "usage_cache:report:xai-oauth:default:oauth|account:c|email:me@example.invalid",
      report("xai-oauth", 5, { plan: "business" }),
    );
    cache.run("usage_cache:report:xai-oauth:default:oauth|account:e", "not json");
    database.close();

    const recorded = listOmpQuotasFrom(path, now);
    const tagsOf = (provider: string, email: string | null) =>
      quotaProviderGroups(recorded, null)
        .find((group) => group.provider === provider)
        ?.accounts.find((account) => account.email === email)?.tags;
    expect(tagsOf("openai-codex", "team@example.invalid")).toEqual(["Business"]);
    expect(tagsOf("openai-codex", "me@example.invalid")).toEqual(["Pro Lite"]);
    expect(tagsOf("anthropic", "me@example.invalid")).toEqual(["Personal"]);
    expect(tagsOf("anthropic", "work@example.invalid")).toEqual(["Example Team"]);
    expect(tagsOf("xai-oauth", null)).toEqual([]);
  });

  test("reads quotas without tags when OMP has no usage cache table", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-no-cache-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    const now = Date.now();
    database
      .prepare(
        "INSERT INTO usage_history VALUES (1, 'anthropic', 'k', 'w', 'Weekly', NULL, 0.1, 'ok', NULL, ?)",
      )
      .run(now);
    database.close();
    expect(listOmpQuotasFrom(path, now)).toEqual([
      expect.objectContaining({ label: "Weekly", plan: null, organization: null }),
    ]);
  });

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
      "INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, 'premium', 'Premium Requests', 'Monthly', 0.1, 'ok', NULL, ?)",
    );
    const copilot = "github-copilot";
    insert.run(1, copilot, "oauth|account:sample", null, "sample", now);
    insert.run(
      2,
      copilot,
      "oauth|account:sample|enterprise:enterprise.example.invalid",
      null,
      "sample",
      now,
    );
    insert.run(3, copilot, "oauth|enterprise:https://other.example.invalid", " ", "other", now);
    insert.run(4, copilot, "legacy-key", "owner@example.com", "ignored", now);
    insert.run(
      5,
      copilot,
      "oauth|enterprise:https://placeholder@invalid.example.invalid",
      null,
      "unsafe",
      now,
    );
    insert.run(6, copilot, "oauth|enterprise:https://[malformed", null, "malformed", now);
    insert.run(7, "anthropic", "oauth|account:private", null, "private-account-id", now);
    database.close();

    const recorded = listOmpQuotasFrom(path, now);
    const groups = quotaProviderGroups(recorded, copilot);
    const accounts = groups[0].accounts;
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "sample", accountService: "github", accountHost: null }),
        expect.objectContaining({
          label: "sample",
          accountService: "ghe",
          accountHost: "enterprise.example.invalid",
        }),
        expect.objectContaining({
          label: "other",
          accountService: "ghe",
          accountHost: "other.example.invalid",
        }),
        expect.objectContaining({ label: "owner@example.com", accountService: null }),
        expect.objectContaining({ label: "unsafe", accountService: null }),
        expect.objectContaining({ label: "malformed", accountService: null }),
      ]),
    );
    expect(
      accounts.filter((account) => account.label === "sample").map(({ suffix }) => suffix),
    ).toEqual(expect.arrayContaining(["Account 1", "Account 2"]));
    const other = recorded.find((quota) => quota.provider === "anthropic");
    expect(other).toEqual(
      expect.objectContaining({ accountId: null, accountService: null, accountHost: null }),
    );
    expect(groups.find((group) => group.provider === "anthropic")?.accounts[0].label).toBeNull();
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
    expect(first.accountKey).not.toContain("enterprise.example.invalid");
    expect(first).toEqual(
      expect.objectContaining({ accountService: "ghe", accountHost: "enterprise.example.invalid" }),
    );
    expect(first.accountId).toBeNull();
    expect(listOmpQuotasFrom(path, now).map(({ accountKey }) => accountKey)).toEqual(
      recorded.map(({ accountKey }) => accountKey),
    );
  });

  test.each([
    {
      name: "an email column",
      columns: "email TEXT,",
      email: "saved@example.com",
      accountId: null,
    },
    {
      name: "an account_id column",
      columns: "account_id TEXT,",
      email: null,
      accountId: "sample-user",
    },
    { name: "neither column", columns: "", email: null, accountId: null },
  ])("reads quota tables with $name", async ({ columns, email, accountId }) => {
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
    if (columns.includes("account_id")) {
      database.prepare("UPDATE usage_history SET account_id = ?").run("sample-user");
    }
    database.close();

    const recorded = listOmpQuotasFrom(path, now);
    expect(recorded).toEqual([
      expect.objectContaining({ email, accountId, label: "Premium Requests" }),
    ]);
    expect(recorded[0]).toEqual(
      expect.objectContaining({ accountService: null, accountHost: null }),
    );
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

describe("session account", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const teamA = "oauth|account:team|email:a@example.invalid|org:team";
  const teamB = "oauth|account:team|email:b@example.invalid|org:team";
  const personal = "oauth|account:me|email:a@example.invalid|org:mine";

  async function database(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-session-accounts-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE usage_history (provider TEXT, account_key TEXT);
      CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT,
        credential_type TEXT, data TEXT, disabled_cause TEXT);
      CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)`);
    const usage = db.prepare("INSERT INTO usage_history VALUES ('openai-codex', ?)");
    for (const key of [teamA, teamB, personal]) usage.run(key);
    const credential = db.prepare(
      "INSERT INTO auth_credentials VALUES (?, 'openai-codex', 'oauth', ?, ?)",
    );
    const data = (email: string, accountId: string, orgId: string, orgName: string) =>
      JSON.stringify({ email, accountId, orgId, orgName, access: "secret-token" });
    credential.run(1, data("a@example.invalid", "team", "team", "Team"), null);
    credential.run(2, data("b@example.invalid", "team", "team", "Team"), null);
    credential.run(3, data("a@example.invalid", "me", "mine", "a@example.invalid"), null);
    credential.run(4, data("gone@example.invalid", "x", "x", "X"), "user");
    const pin = db.prepare("INSERT INTO cache VALUES (?, ?, ?)");
    const future = Math.floor(Date.now() / 1000) + 3_600;
    pin.run(
      "session:sticky:openai-codex:bundled-session",
      JSON.stringify({ type: "oauth", index: 1, credentialId: 2, lastUsedAtMs: 1 }),
      future,
    );
    pin.run(
      "session:sticky:openai-codex:expired-session",
      JSON.stringify({ type: "oauth", index: 0, credentialId: 1, lastUsedAtMs: 1 }),
      1,
    );
    db.close();
    return path;
  }

  const noSession = async () => null;

  function registryWith(controls: Partial<OmpSubagentControls>): OmpSubagentControlRegistry {
    const registry = new OmpSubagentControlRegistry();
    registry.register("agent-1", {
      cancelSubagent: async () => false,
      steerSubagent: async () => {},
      listProviderAccounts: async () => [],
      ...controls,
    });
    return registry;
  }

  test("links each login to its own usage when team seats share an account id and emails repeat across orgs", async () => {
    const login = (credentialId: number, active = false) => ({
      credentialId,
      provider: "openai-codex",
      label: `login ${credentialId}`,
      type: "oauth" as const,
      active,
    });
    const registry = registryWith({
      listProviderAccounts: async () => [
        login(2, true),
        login(1),
        login(3),
        { ...login(9), type: "api_key" },
      ],
    });

    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "openai-codex" },
      registry,
      noSession,
      await database(),
    );

    expect(result.accounts).toEqual([
      { credentialId: 2, label: "login 2", active: true, quotaAccountKeys: [sha(teamB)] },
      { credentialId: 1, label: "login 1", active: false, quotaAccountKeys: [sha(teamA)] },
      { credentialId: 3, label: "login 3", active: false, quotaAccountKeys: [sha(personal)] },
    ]);
  });

  test("explains an OMP too old to list logins", async () => {
    const outdated = registryWith({
      listProviderAccounts: async () => {
        throw new OmpRpcRequestRejectedError(undefined, "unsupported_command");
      },
    });

    await expect(
      resolveListOmpSessionAccounts(
        { agentId: "agent-1", provider: "openai-codex" },
        outdated,
        noSession,
        await database(),
      ),
    ).rejects.toThrow("Update OMP to show which login this session uses");
  });

  test("reads the pin OMP recorded for a session no OMP Plugin runtime owns, such as Paseo's bundled omp", async () => {
    const path = await database();
    const empty = new OmpSubagentControlRegistry();
    const forSession = (sessionId: string | null) => async (agentId: string) =>
      agentId === "bundled-agent" ? sessionId : null;
    const list = (sessionId: string | null) =>
      resolveListOmpSessionAccounts(
        { agentId: "bundled-agent", provider: "openai-codex" },
        empty,
        forSession(sessionId),
        path,
      );

    expect((await list("bundled-session")).accounts).toEqual([
      {
        credentialId: 1,
        label: "a@example.invalid (Team)",
        active: false,
        quotaAccountKeys: [sha(teamA)],
      },
      {
        credentialId: 2,
        label: "b@example.invalid (Team)",
        active: true,
        quotaAccountKeys: [sha(teamB)],
      },
      {
        credentialId: 3,
        label: "a@example.invalid",
        active: false,
        quotaAccountKeys: [sha(personal)],
      },
    ]);
    // An expired pin marks nothing; the logins stay switchable.
    expect((await list("expired-session")).accounts.some((login) => login.active)).toBe(false);
    // No stored session at all is not an error: the popover simply cannot name the account.
    expect((await list(null)).accounts).toEqual([]);
  });

  test("puts the account in use first and builds the pin command OMP accepts", () => {
    const groups = quotaProviderGroups(
      [
        { ...quotas[0], accountKey: "busy", usedFraction: 0.9 },
        { ...quotas[0], accountKey: "idle", usedFraction: 0.1 },
        { ...quotas[0], accountKey: "unlinked", usedFraction: 0.5 },
      ],
      "anthropic",
    );
    const linked = quotaSessionAccounts(groups[0].accounts, [
      { credentialId: 4, label: "busy", active: false, quotaAccountKeys: ["busy"] },
      { credentialId: 7, label: "idle", active: true, quotaAccountKeys: ["idle"] },
    ]);

    expect(
      linked.map(({ accountKey, inUse, login }) => [accountKey, inUse, login?.credentialId]),
    ).toEqual([
      ["idle", true, 7],
      ["busy", false, 4],
      ["unlinked", false, undefined],
    ]);
    expect(sessionPinCommand(4)).toBe("/session pin OAuth credential #4");
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
    expect(quotaSummaryForProvider(quotas, null, true)).toMatchObject({
      visible: true,
      label: "Quotas · 90%",
    });
    expect(quotaSeverityForProvider(quotas, null, true)).toBe("danger");
    expect(quotaSummaryForProvider([], null, true)).toMatchObject({
      visible: true,
      label: "Quotas · —",
    });
    expect(quotaSummaryForProvider(quotas, null).visible).toBe(false);
  });
});
