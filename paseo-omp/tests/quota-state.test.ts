import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test, vi } from "vitest";
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
import contribute from "../index.server";
import { OmpRpcRequestRejectedError } from "../server/provider/omp-rpc-transport";
import {
  listOmpQuotasFrom,
  resolveListOmpQuotas,
  resolveListOmpSessionAccounts,
} from "../server/quota";
import { OmpSubagentControlRegistry, type OmpSubagentControls } from "../server/subagents";
import { accountTags } from "../shared/account-tags";
import { listOmpSessionAccounts, type OmpQuota } from "../shared/quota";

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
      onlyLogin: false,
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
    // A linked account whose rows hold no usage value does not hide the provider's peak.
    const unread: OmpQuota[] = [
      ...rows,
      { ...quotas[0], accountKey: "unread", usedFraction: null },
    ];
    expect(
      quotaSummaryForProvider(unread, "anthropic", false, {
        ...working,
        quotaAccountKeys: ["unread"],
      }),
    ).toEqual({
      visible: true,
      label: "100%",
      title: "Anthropic · all accounts · 100% (last recorded usage, not live)",
    });
    expect(
      quotaSeverityForProvider(unread, "anthropic", false, {
        ...working,
        quotaAccountKeys: ["unread"],
      }),
    ).toBe("danger");
  });

  test("keeps IN USE on the login in use when two logins share a usage account", () => {
    const account = quotaProviderGroups([{ ...quotas[0], accountKey: "shared" }], "anthropic")[0]
      .accounts;
    const login = { label: "me@example.invalid", onlyLogin: false, quotaAccountKeys: ["shared"] };
    const [linked] = quotaSessionAccounts(account, [
      { ...login, credentialId: 3, active: false },
      { ...login, credentialId: 5, active: true },
    ]);
    expect(linked.inUse).toBe(true);
    expect(linked.login?.credentialId).toBe(5);
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
    usage.run(7, "github-copilot", "oauth|account:h", null, now);
    usage.run(
      6,
      "openai-codex",
      "oauth|account:g|email:mixed@example.invalid",
      "mixed@example.invalid",
      now,
    );
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
    // A blank planType falls back to the report's plan.
    cache.run(
      "usage_cache:report:github-copilot:default:oauth|account:h",
      report("github-copilot", 1, { planType: "  ", plan: "business" }),
    );
    cache.run("usage_cache:report:xai-oauth:default:oauth|account:e", "not json");
    cache.run("usage_cache:report:xai-oauth:other:oauth|account:e", null);
    // A newer report names only a plan, an older one only an organization: never mixed.
    cache.run(
      "usage_cache:report:1:openai-codex:default:oauth|account:g|email:mixed@example.invalid",
      report("openai-codex", 9, { planType: "plus" }),
    );
    cache.run(
      "usage_cache:report:0:openai-codex:default:oauth|account:g|email:mixed@example.invalid",
      report("openai-codex", 3, { orgName: "Example Team" }),
    );
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
    expect(tagsOf("openai-codex", "mixed@example.invalid")).toEqual(["Plus"]);
    expect(tagsOf("github-copilot", null)).toEqual(["Business"]);
  });

  test("names a plan that matches an Object member as a plan", () => {
    for (const plan of ["constructor", "__proto__", "toString"]) {
      const tags = accountTags({ plan, organization: null, email: null });
      expect(tags).toEqual([plan.charAt(0).toUpperCase() + plan.slice(1)]);
      expect(typeof tags[0]).toBe("string");
    }
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
  const LOCATION_ENV = [
    "PASEO_OMP_AGENT_DIR",
    "OMP_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_DIR",
    "XDG_DATA_HOME",
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A fresh HOME, so the daemon default store is `<home>/.omp/agent` and profiles sit beside it. */
  async function home(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-session-accounts-"));
    quotaRoots.push(root);
    for (const name of LOCATION_ENV) vi.stubEnv(name, undefined);
    vi.stubEnv("HOME", root);
    return root;
  }

  type Login = {
    id: number;
    email?: string;
    accountId?: string;
    orgId?: string;
    orgName?: string;
    disabled?: boolean;
    /** A stored API key instead of an OAuth login. */
    apiKey?: boolean;
  };

  /** OMP's tables with only the columns this reads; tokens sit beside identity as in OMP. */
  async function store(
    agentDir: string,
    seed: {
      provider: string;
      usage: string[];
      logins: Login[];
      pins?: Array<[sessionId: string, credentialId: number, expiresAtSec: number]>;
    },
  ): Promise<void> {
    await mkdir(agentDir, { recursive: true });
    const db = new DatabaseSync(join(agentDir, "agent.db"));
    db.exec(`CREATE TABLE usage_history (provider TEXT, account_key TEXT);
      CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT,
        credential_type TEXT, data TEXT, disabled_cause TEXT);
      CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)`);
    for (const key of seed.usage) {
      db.prepare("INSERT INTO usage_history VALUES (?, ?)").run(seed.provider, key);
    }
    for (const { id, disabled, apiKey, ...identity } of seed.logins) {
      db.prepare("INSERT INTO auth_credentials VALUES (?, ?, ?, ?, ?)").run(
        id,
        seed.provider,
        apiKey ? "api_key" : "oauth",
        JSON.stringify({ ...identity, access: "unread-placeholder" }),
        disabled ? "user" : null,
      );
    }
    for (const [sessionId, credentialId, expiresAt] of seed.pins ?? []) {
      db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(
        `session:sticky:${seed.provider}:${sessionId}`,
        JSON.stringify({ type: "oauth", index: 0, credentialId, lastUsedAtMs: 1 }),
        expiresAt,
      );
    }
    db.close();
  }

  const future = () => Math.floor(Date.now() / 1000) + 3_600;

  const codexTeam = (agentDir: string) =>
    store(agentDir, {
      provider: "openai-codex",
      usage: [teamA, teamB, personal],
      logins: [
        { id: 1, email: "a@example.invalid", accountId: "team", orgId: "team", orgName: "Team" },
        { id: 2, email: "b@example.invalid", accountId: "team", orgId: "team", orgName: "Team" },
        {
          id: 3,
          email: "a@example.invalid",
          accountId: "me",
          orgId: "mine",
          orgName: "a@example.invalid",
        },
        {
          id: 4,
          email: "gone@example.invalid",
          accountId: "x",
          orgId: "x",
          orgName: "X",
          disabled: true,
        },
      ],
      pins: [
        ["bundled-session", 2, future()],
        ["expired-session", 1, 1],
      ],
    });

  const agentLookup =
    (provider: string, sessionId: string | null = null) =>
    async () => ({ provider, sessionId });

  function registryWith(controls: Partial<OmpSubagentControls>): OmpSubagentControlRegistry {
    const registry = new OmpSubagentControlRegistry();
    registry.register("agent-1", {
      cancelSubagent: async () => false,
      steerSubagent: async () => {},
      listProviderAccounts: async () => [],
      modelProvider: () => null,
      ...controls,
    });
    return registry;
  }

  const runtimeLogin = (credentialId: number, active = false) => ({
    credentialId,
    provider: "openai-codex",
    label: `login ${credentialId}`,
    type: "oauth" as const,
    active,
  });

  test("links each login to its own usage when team seats share an account id and emails repeat across orgs", async () => {
    await codexTeam(join(await home(), ".omp", "agent"));
    const registry = registryWith({
      listProviderAccounts: async () => [
        runtimeLogin(2, true),
        runtimeLogin(1),
        runtimeLogin(3),
        { ...runtimeLogin(9), type: "api_key" },
      ],
    });

    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "openai-codex" },
      registry,
      agentLookup("omp-plugin"),
    );

    expect(result.accounts).toEqual([
      {
        credentialId: 2,
        label: "login 2",
        active: true,
        onlyLogin: false,
        quotaAccountKeys: [sha(teamB)],
      },
      {
        credentialId: 1,
        label: "login 1",
        active: false,
        onlyLogin: false,
        quotaAccountKeys: [sha(teamA)],
      },
      {
        credentialId: 3,
        label: "login 3",
        active: false,
        onlyLogin: false,
        quotaAccountKeys: [sha(personal)],
      },
    ]);
  });

  test("explains an OMP too old to list logins", async () => {
    await codexTeam(join(await home(), ".omp", "agent"));
    const outdated = registryWith({
      listProviderAccounts: async () => {
        throw new OmpRpcRequestRejectedError(undefined, "unsupported_command");
      },
    });

    await expect(
      resolveListOmpSessionAccounts(
        { agentId: "agent-1", provider: "openai-codex" },
        outdated,
        agentLookup("omp-plugin"),
      ),
    ).rejects.toThrow("Update OMP to show which login this session uses");
  });

  test("reads the pin OMP recorded for a session no OMP Plugin runtime owns, such as Paseo's bundled omp", async () => {
    await codexTeam(join(await home(), ".omp", "agent"));
    const list = (sessionId: string | null) =>
      resolveListOmpSessionAccounts(
        { agentId: "bundled-agent", provider: "openai-codex" },
        new OmpSubagentControlRegistry(),
        agentLookup("omp", sessionId),
      );

    expect((await list("bundled-session")).accounts).toEqual([
      {
        credentialId: 1,
        label: "a@example.invalid (Team)",
        active: false,
        onlyLogin: false,
        quotaAccountKeys: [sha(teamA)],
      },
      {
        credentialId: 2,
        label: "b@example.invalid (Team)",
        active: true,
        onlyLogin: false,
        quotaAccountKeys: [sha(teamB)],
      },
      {
        credentialId: 3,
        label: "a@example.invalid",
        active: false,
        onlyLogin: false,
        quotaAccountKeys: [sha(personal)],
      },
    ]);
    // An expired pin marks nothing; the logins stay switchable.
    expect((await list("expired-session")).accounts.some((login) => login.active)).toBe(false);
    // No stored session at all is not an error: the popover simply cannot name the account.
    expect((await list(null)).accounts).toEqual([]);
  });

  test("serves the registered RPC from Paseo's own record of the agent", async () => {
    await codexTeam(join(await home(), ".omp", "agent"));
    const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
    const cleanup = contribute({
      handle(contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) {
        handlers.set(contract.name, handler);
      },
      on: () => () => {},
      before: () => () => {},
      registerSettings: () => ({ subscribe: () => () => {} }),
      registerProvider: () => {},
    } as unknown as PluginServerContext);
    const records: Record<string, unknown> = {
      bundled: {
        agent: { provider: "omp", persistence: { provider: "omp", sessionId: "bundled-session" } },
      },
      // Another provider's session id is not an OMP session.
      foreign: {
        agent: {
          provider: "omp",
          persistence: { provider: "codex", sessionId: "bundled-session" },
        },
      },
      gone: null,
    };
    const paseo = {
      agents: {
        ref: (agentId: string) => ({
          refresh: async () => {
            if (agentId === "broken") throw new Error("offline");
            return records[agentId];
          },
        }),
      },
    };
    const list = async (agentId: string) =>
      listOmpSessionAccounts.output.parse(
        await handlers.get(listOmpSessionAccounts.name)?.(
          { agentId, provider: "openai-codex" },
          { paseo },
        ),
      ).accounts;
    try {
      expect((await list("bundled")).filter((login) => login.active)).toEqual([
        expect.objectContaining({ credentialId: 2 }),
      ]);
      for (const agentId of ["foreign", "gone", "broken"]) {
        expect(await list(agentId)).toEqual([]);
      }
    } finally {
      cleanup();
    }
  });

  test("reads a profile agent's logins and usage from that profile, never the default store", async () => {
    const root = await home();
    const profileUsage = "oauth|account:p|email:profile@example.invalid";
    const defaultUsage = "oauth|account:d|email:default@example.invalid";
    // The same credential id is a different account in each store.
    await store(join(root, ".omp", "agent"), {
      provider: "anthropic",
      usage: [defaultUsage],
      logins: [{ id: 1, email: "default@example.invalid", accountId: "d" }],
      pins: [["session-1", 1, future()]],
    });
    await store(join(root, ".omp", "profiles", "team-a", "agent"), {
      provider: "anthropic",
      usage: [profileUsage],
      logins: [{ id: 1, email: "profile@example.invalid", accountId: "p" }],
      pins: [["session-1", 1, future()]],
    });
    const list = (provider: string) =>
      resolveListOmpSessionAccounts(
        { agentId: "agent-1", provider: "anthropic" },
        new OmpSubagentControlRegistry(),
        agentLookup(provider, "session-1"),
      );

    expect((await list("omp-plugin-team-a")).accounts).toEqual([
      {
        credentialId: 1,
        label: "profile@example.invalid",
        active: true,
        onlyLogin: true,
        quotaAccountKeys: [sha(profileUsage)],
      },
    ]);
    expect((await list("omp")).accounts).toEqual([
      {
        credentialId: 1,
        label: "default@example.invalid",
        active: true,
        onlyLogin: true,
        quotaAccountKeys: [sha(defaultUsage)],
      },
    ]);
  });

  test("never hands a removed login's leftover usage to the login that replaced it", async () => {
    const root = await home();
    await store(join(root, ".omp", "agent"), {
      provider: "anthropic",
      usage: ["oauth|account:old|email:old@example.invalid|org:o"],
      logins: [{ id: 7, email: "new@example.invalid", accountId: "new", orgId: "o" }],
      pins: [["session-1", 7, future()]],
    });
    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "anthropic" },
      new OmpSubagentControlRegistry(),
      agentLookup("omp", "session-1"),
    );

    expect(result.accounts).toEqual([
      expect.objectContaining({ credentialId: 7, quotaAccountKeys: [] }),
    ]);
  });

  test("flags a provider's only login without claiming it is in use, and links no usage it cannot prove is its own", async () => {
    const root = await home();
    // Copilot's shape: no identity on the login, only an enterprise host and fingerprint in the key.
    const copilot = "oauth|enterprise:host-1|secret:fingerprint-1";
    // No pin: the session has not sent a Copilot request yet, as for a freshly opened agent.
    await store(join(root, ".omp", "agent"), {
      provider: "github-copilot",
      usage: [copilot],
      logins: [{ id: 8 }],
    });

    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "github-copilot" },
      new OmpSubagentControlRegistry(),
      agentLookup("omp", "session-1"),
    );

    expect(result.accounts).toEqual([
      {
        credentialId: 8,
        label: "OAuth credential #8",
        active: false,
        onlyLogin: true,
        // One login and one usage account do not prove the usage is this login's.
        quotaAccountKeys: [],
      },
    ]);
  });

  test("keeps the runtime's not-in-use answer for a sole login, as when an environment key serves the session", async () => {
    await home();
    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "openai-codex" },
      registryWith({ listProviderAccounts: async () => [runtimeLogin(2, false)] }),
      agentLookup("omp-plugin"),
    );

    expect(result.accounts).toEqual([
      expect.objectContaining({ credentialId: 2, active: false, onlyLogin: true }),
    ]);
  });

  test("does not call an OAuth login the only one when a stored API key sits beside it", async () => {
    const root = await home();
    await store(join(root, ".omp", "agent"), {
      provider: "anthropic",
      usage: [],
      logins: [
        { id: 1, email: "a@example.invalid", accountId: "a" },
        { id: 2, apiKey: true },
      ],
    });

    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "anthropic" },
      new OmpSubagentControlRegistry(),
      agentLookup("omp", "session-1"),
    );

    expect(result.accounts).toEqual([
      expect.objectContaining({ credentialId: 1, active: false, onlyLogin: false }),
    ]);
  });

  test("compares organizations even for a provider's only login and usage account", async () => {
    const root = await home();
    const list = async (usage: string) => {
      await rm(join(root, ".omp"), { recursive: true, force: true });
      await store(join(root, ".omp", "agent"), {
        provider: "anthropic",
        usage: [usage],
        logins: [{ id: 5, orgId: "a" }],
      });
      return resolveListOmpSessionAccounts(
        { agentId: "agent-1", provider: "anthropic" },
        new OmpSubagentControlRegistry(),
        agentLookup("omp", "session-1"),
      );
    };

    expect((await list("oauth|org:b")).accounts[0]?.quotaAccountKeys).toEqual([]);
    expect((await list("oauth|org:a")).accounts[0]?.quotaAccountKeys).toEqual([sha("oauth|org:a")]);
  });

  test("answers nothing when Paseo cannot name the agent, even with its runtime still registered", async () => {
    const root = await home();
    // A login in the default store shares the credential id the profile runtime reports.
    await store(join(root, ".omp", "agent"), {
      provider: "openai-codex",
      usage: [teamA],
      logins: [{ id: 2, email: "a@example.invalid", accountId: "team", orgId: "team" }],
    });

    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "openai-codex" },
      registryWith({ listProviderAccounts: async () => [runtimeLogin(2, true)] }),
      async () => null,
    );

    expect(result).toEqual({ accounts: [] });
  });

  test("keeps an organization-scoped login apart from the same email's org-less usage, as OMP does", async () => {
    const root = await home();
    const orgless = "oauth|account:same|email:same@example.invalid";
    const scoped = "oauth|account:same|email:same@example.invalid|org:corp";
    await store(join(root, ".omp", "agent"), {
      provider: "anthropic",
      usage: [orgless, scoped],
      logins: [
        { id: 1, email: "same@example.invalid", accountId: "same", orgId: "corp" },
        { id: 2, email: "same@example.invalid", accountId: "same" },
      ],
    });

    const result = await resolveListOmpSessionAccounts(
      { agentId: "agent-1", provider: "anthropic" },
      registryWith({
        listProviderAccounts: async () => [
          { ...runtimeLogin(1), provider: "anthropic" },
          { ...runtimeLogin(2), provider: "anthropic" },
        ],
      }),
      agentLookup("omp-plugin"),
    );

    expect(result.accounts.map((login) => [login.credentialId, login.quotaAccountKeys])).toEqual([
      [1, [sha(scoped)]],
      [2, [sha(orgless)]],
    ]);
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
      {
        credentialId: 4,
        label: "busy",
        active: false,
        onlyLogin: false,
        quotaAccountKeys: ["busy"],
      },
      {
        credentialId: 7,
        label: "idle",
        active: true,
        onlyLogin: false,
        quotaAccountKeys: ["idle"],
      },
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
