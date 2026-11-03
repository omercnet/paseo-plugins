import { describe, expect, test } from "vitest";
import {
  accountGroups,
  accountsPollInterval,
  balanceLine,
  signInProviders,
  usedPercent,
} from "../client/omp-accounts-state";
import type { OmpAccount, OmpAccountsView, OmpLogin } from "../shared/omp-accounts";

function account(provider: string, credentialId: number): OmpAccount {
  return {
    provider,
    credentialId,
    oauth: true,
    label: `${provider}-${credentialId}`,
    limits: [],
    usageAt: null,
    usageIsRecorded: false,
    resets: null,
    steering: null,
  };
}

function view(overrides: Partial<OmpAccountsView> = {}): OmpAccountsView {
  return {
    installed: true,
    providers: [],
    accounts: [],
    logins: [],
    balance: [],
    settings: {},
    fetchedAt: 1,
    error: null,
    ...overrides,
  };
}

function login(step: OmpLogin["step"]): OmpLogin {
  return {
    id: step,
    provider: "anthropic",
    step,
    url: null,
    instructions: null,
    codePrompt: null,
    message: null,
  };
}

describe("account groups", () => {
  test("groups logins by provider in OMP's provider order and skips providers without a login", () => {
    const groups = accountGroups(
      view({
        providers: [
          { id: "openai-codex", name: "ChatGPT", authenticated: true },
          { id: "xai", name: "xAI", authenticated: false },
          { id: "anthropic", name: "Anthropic", authenticated: true },
        ],
        accounts: [account("anthropic", 3), account("openai-codex", 2), account("anthropic", 4)],
      }),
    );

    expect(
      groups.map((group) => [group.provider.id, group.accounts.map((a) => a.credentialId)]),
    ).toEqual([
      ["openai-codex", [2]],
      ["anthropic", [3, 4]],
    ]);
  });

  test("a login for a provider OMP no longer lists still shows, named by its id", () => {
    const groups = accountGroups(view({ accounts: [account("retired", 1)] }));

    expect(groups).toEqual([
      {
        provider: { id: "retired", name: "retired", authenticated: true },
        accounts: [account("retired", 1)],
      },
    ]);
  });
});

describe("sign-in provider picker", () => {
  const providers = [
    { id: "zai", name: "Z.ai", authenticated: false },
    { id: "openai-codex", name: "ChatGPT", authenticated: true },
    { id: "anthropic", name: "Anthropic", authenticated: true },
    { id: "xai", name: "xAI", authenticated: false },
  ];

  test("lists providers that already have a login first, then by name", () => {
    expect(signInProviders(providers, "").map((p) => p.id)).toEqual([
      "anthropic",
      "openai-codex",
      "xai",
      "zai",
    ]);
  });

  test("filters by name or id, ignoring case and surrounding space", () => {
    expect(signInProviders(providers, "  CHAT ").map((p) => p.id)).toEqual(["openai-codex"]);
    expect(signInProviders(providers, "zai").map((p) => p.id)).toEqual(["zai"]);
    expect(signInProviders(providers, "nothing")).toEqual([]);
  });
});

describe("polling", () => {
  test("polls quickly only while a sign-in is moving", () => {
    expect(accountsPollInterval(undefined)).toBe(30_000);
    expect(
      accountsPollInterval(view({ logins: [login("done"), login("failed"), login("canceled")] })),
    ).toBe(30_000);
    for (const step of ["starting", "waiting", "verifying"] as const) {
      expect(accountsPollInterval(view({ logins: [login(step)] }))).toBe(1_000);
    }
  });
});

describe("labels", () => {
  test("a limit past its cap still draws as a full bar", () => {
    expect(usedPercent(0.256)).toBe(26);
    expect(usedPercent(1.4)).toBe(100);
  });

  test("the balance line names every login that gets agents, or says none does", () => {
    const shares = [
      { label: "a", percent: 70 },
      { label: "b", percent: 30 },
    ];
    expect(balanceLine({ provider: "anthropic", model: "anthropic/m", shares })).toBe(
      "New agents on anthropic/m go to a 70%, b 30%",
    );
    expect(balanceLine({ provider: "anthropic", model: "anthropic/m", shares: [] })).toBe(
      "New agents on anthropic/m go to no login",
    );
  });
});
