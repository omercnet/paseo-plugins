import { describe, expect, test } from "vitest";
import { applySteering } from "../server/omp-accounts";
import {
  OmpAccountProviderIdSchema,
  OmpAccountsSettingPathSchema,
  OmpAccountsViewSchema,
  redeemOmpAccountReset,
  setOmpAccountSteering,
  setOmpAccountsSetting,
  submitOmpAccountLoginCode,
} from "../shared/omp-accounts";

const KEY_A = { provider: "anthropic", accountId: "acc-a", orgId: null };
const KEY_B = { provider: "anthropic", accountId: "acc-b", orgId: "org-b" };

describe("RPC input validation", () => {
  test("provider ids never start with a dash, so they cannot become omp flags", () => {
    expect(OmpAccountProviderIdSchema.safeParse("openai-codex").success).toBe(true);
    expect(OmpAccountProviderIdSchema.safeParse("z.ai").success).toBe(true);
    for (const bad of ["-x", "--json", "", "Anthropic", "a b", "a/b"]) {
      expect(OmpAccountProviderIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("account refs need a non-negative integer credential id", () => {
    const ok = redeemOmpAccountReset.input.safeParse({ provider: "anthropic", credentialId: 3 });
    expect(ok.success).toBe(true);
    for (const credentialId of [-1, 1.5, "3", null]) {
      expect(
        redeemOmpAccountReset.input.safeParse({ provider: "anthropic", credentialId }).success,
      ).toBe(false);
    }
  });

  test("a pasted code is trimmed, never empty, and bounded", () => {
    const parsed = submitOmpAccountLoginCode.input.safeParse({ loginId: "x", code: "  abc  " });
    expect(parsed.success && parsed.data.code).toBe("abc");
    expect(submitOmpAccountLoginCode.input.safeParse({ loginId: "x", code: "   " }).success).toBe(
      false,
    );
    expect(
      submitOmpAccountLoginCode.input.safeParse({ loginId: "x", code: "a".repeat(5000) }).success,
    ).toBe(false);
  });

  test("reserve is a whole percentage from 0 to 90, or null to clear it", () => {
    const ref = { provider: "anthropic", credentialId: 1 };
    for (const reservePct of [0, 90, null, undefined]) {
      expect(setOmpAccountSteering.input.safeParse({ ...ref, reservePct }).success).toBe(true);
    }
    for (const reservePct of [-1, 91, 12.5, "10"]) {
      expect(setOmpAccountSteering.input.safeParse({ ...ref, reservePct }).success).toBe(false);
    }
  });

  test("only the steering settings can be written through the accounts setting RPC", () => {
    expect(OmpAccountsSettingPathSchema.options).toHaveLength(7);
    expect(
      setOmpAccountsSetting.input.safeParse({ path: "retry.usageReservePct", value: 20 }).success,
    ).toBe(true);
    expect(
      setOmpAccountsSetting.input.safeParse({ path: "retry.usageReservePct", value: null }).success,
    ).toBe(true);
    for (const path of ["auth.accountPolicies", "auth.broker.token", "retry.enabled", ""]) {
      expect(setOmpAccountsSetting.input.safeParse({ path, value: 1 }).success).toBe(false);
    }
    expect(
      setOmpAccountsSetting.input.safeParse({ path: "retry.usageReservePct", value: { a: 1 } })
        .success,
    ).toBe(false);
  });

  test("the view rejects an unknown settings key so stray config never reaches the client", () => {
    const view = {
      installed: true,
      providers: [],
      accounts: [],
      logins: [],
      balance: [],
      settings: { "retry.usageReservePct": 10 },
      fetchedAt: 1,
      error: null,
    };
    expect(OmpAccountsViewSchema.safeParse(view).success).toBe(true);
    expect(
      OmpAccountsViewSchema.safeParse({ ...view, settings: { "auth.broker.token": "x" } }).success,
    ).toBe(false);
  });
});

describe("applySteering", () => {
  test("creates a preferred policy with the reclaim threshold above the default reserve", () => {
    expect(applySteering([], KEY_A, { preferred: true }, 10)).toEqual([
      {
        provider: "anthropic",
        account: { accountId: "acc-a" },
        priority: 100,
        reclaimAbovePct: 25,
      },
    ]);
  });

  test("includes the org id in the account selector when OMP gives one", () => {
    expect(applySteering([], KEY_B, { reservePct: 5 }, 10)).toEqual([
      { provider: "anthropic", account: { accountId: "acc-b", orgId: "org-b" }, reservePct: 5 },
    ]);
  });

  test("a login's own reserve, not the default, sets its reclaim threshold", () => {
    const [policy] = applySteering([], KEY_A, { preferred: true, reservePct: 40 }, 10);
    expect(policy).toMatchObject({ reservePct: 40, reclaimAbovePct: 55 });
    const [raised] = applySteering([policy], KEY_A, { reservePct: 60 }, 10);
    expect(raised).toMatchObject({ reservePct: 60, reclaimAbovePct: 75 });
    const [lowered] = applySteering([raised], KEY_A, { reservePct: null }, 10);
    expect(lowered).toMatchObject({ priority: 100, reclaimAbovePct: 25 });
    expect(lowered).not.toHaveProperty("reservePct");
  });

  test("caps the reclaim threshold at 100 and drops it when nothing is left to reclaim", () => {
    const [nearCap] = applySteering([], KEY_A, { preferred: true, reservePct: 90 }, 10);
    expect(nearCap?.reclaimAbovePct).toBe(100);
    const [full] = applySteering([], KEY_A, { preferred: true }, 100);
    expect(full).not.toHaveProperty("reclaimAbovePct");
  });

  test("preferring one login demotes the previously preferred login of the same provider only", () => {
    const start = applySteering([], KEY_A, { preferred: true, reservePct: 20 }, 10);
    const other = applySteering(
      start,
      { provider: "openai-codex", accountId: "c", orgId: null },
      { preferred: true },
      10,
    );
    const next = applySteering(other, KEY_B, { preferred: true }, 10);

    expect(next).toEqual([
      { provider: "anthropic", account: { accountId: "acc-a" }, reservePct: 20 },
      { provider: "openai-codex", account: { accountId: "c" }, priority: 100, reclaimAbovePct: 25 },
      {
        provider: "anthropic",
        account: { accountId: "acc-b", orgId: "org-b" },
        priority: 100,
        reclaimAbovePct: 25,
      },
    ]);
  });

  test("leaves a user's own non-100 priority alone when preferring another login", () => {
    const user = [{ provider: "anthropic", account: { accountId: "acc-b" }, priority: 7 }];
    const next = applySteering(user, KEY_A, { preferred: true }, 10);
    expect(next[0]).toEqual(user[0]);
  });

  test("un-preferring removes only the plugin's priority and reclaim, keeping the reserve", () => {
    const start = applySteering([], KEY_A, { preferred: true, reservePct: 30 }, 10);
    expect(applySteering(start, KEY_A, { preferred: false }, 10)).toEqual([
      { provider: "anthropic", account: { accountId: "acc-a" }, reservePct: 30 },
    ]);
  });

  test("an empty change is a no-op and never invents a policy", () => {
    expect(applySteering([], KEY_A, {}, 10)).toEqual([]);
    const existing = [{ provider: "anthropic", account: { accountId: "acc-a" }, reservePct: 5 }];
    expect(applySteering(existing, KEY_A, {}, 10)).toEqual(existing);
  });

  test("does not mutate the policies it was given", () => {
    const input = [{ provider: "anthropic", account: { accountId: "acc-a" }, reservePct: 5 }];
    const snapshot = structuredClone(input);
    applySteering(input, KEY_A, { preferred: true, reservePct: null }, 10);
    expect(input).toEqual(snapshot);
  });

  test("distinguishes two logins of one account id by org", () => {
    const sameAccount = { provider: "anthropic", accountId: "acc-b", orgId: null };
    const next = applySteering(
      applySteering([], KEY_B, { reservePct: 5 }, 10),
      sameAccount,
      { reservePct: 50 },
      10,
    );
    expect(next).toHaveLength(2);
    expect(next.map((policy) => policy.reservePct)).toEqual([5, 50]);
  });
});
