import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OmpAccounts } from "../server/omp-accounts";
import type { OmpAccountsView, OmpLogin } from "../shared/omp-accounts";

interface Scenario {
  providers: unknown[];
  /** Logins by the provider id `get_logout_accounts` is asked about. */
  accounts: Record<string, unknown[]>;
  usage: unknown;
  /** Printed instead of `usage` JSON when set. */
  usageRaw?: string;
  resets: unknown;
  history: unknown;
  models: unknown;
  balance: unknown;
  /** Credential ids `logout` finds; any other id answers with an error frame that has no `data`. */
  known: number[];
  /** `usage reset <provider>/<id>` exits 0 for these refs and 1 otherwise. */
  redeemable: string[];
  /** Where the fake writes its pid when it starts a sign-in. */
  pidFile: string;
  /** The `auth.accountPolicies` the fake starts with; `config set` rewrites this file. */
  policies: unknown[];
  policyFile: string;
  /** Other settings `config set` changed, as JSON `{ overrides }`. */
  stateFile: string;
  /** Every invocation's argv is appended here as JSON lines. */
  logFile: string;
}

/** A scripted `omp`: the account rpc commands plus the `usage`, `models` and `dry-balance` reads. */
function fakeOmp(scenario: Scenario): string {
  return `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const { writeFileSync } = require("node:fs");
const S = ${JSON.stringify(scenario)};
const args = process.argv.slice(2);
if (S.logFile) require("node:fs").appendFileSync(S.logFile, JSON.stringify(args) + "\\n");
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
if (args[0] === "--version") { console.log("omp/fake"); process.exit(0); }
if (args.includes("--mode")) {
  let loginId = null;
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const respond = (data) => print({ type: "response", id: request.id, success: true, data });
    if (request.type === "get_login_providers") return respond({ providers: S.providers });
    if (request.type === "get_logout_accounts") return respond({ accounts: S.accounts[request.providerId] ?? [] });
    if (request.type === "logout") {
      if (S.known.includes(request.credentialId)) return respond({});
      return print({ type: "response", id: request.id, success: false, error: "Credential " + request.credentialId + " is not stored for " + request.providerId });
    }
    if (request.type === "login") {
      writeFileSync(S.pidFile, String(process.pid));
      loginId = request.id;
      print({ type: "extension_ui_request", id: "ui-1", method: "open_url", url: "https://example.test/authorize", instructions: "Enter code ABCD" });
      print({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "Waiting for browser authentication..." });
      print({ type: "extension_ui_request", id: "ui-3", method: "input", title: "Paste the authorization code" });
      return;
    }
    if (request.type === "extension_ui_response") {
      if (request.value === "good") return print({ type: "response", id: loginId, success: true, data: {} });
      return print({ type: "extension_ui_request", id: "ui-4", method: "input", title: "Paste the authorization code" });
    }
  });
} else if (args[0] === "usage" && args[1] === "invalidate") {
  process.exit(0);
} else if (args[0] === "usage" && args[1] === "reset" && args[2] === "--json") {
  print(S.resets);
} else if (args[0] === "usage" && args[1] === "reset") {
  if (!S.redeemable.includes(args[2])) fail("No stored account matches " + args[2]);
  console.log("Used a reset on " + args[2]);
} else if (args[0] === "usage" && args.includes("--history")) {
  print(S.history);
} else if (args[0] === "usage") {
  if (S.usageRaw !== undefined) console.log(S.usageRaw); else print(S.usage);
} else if (args[0] === "config") {
  const { readFileSync } = require("node:fs");
  const defaults = {
    "retry.usageReservePct": { value: 10, type: "number" },
    "retry.usageReservePolicy": { value: "auto", type: "enum" },
    "retry.waitForUsageReset": { value: false, type: "boolean" },
    "codexResets.autoRedeem": { value: "unset", type: "enum" },
    "auth.broker.url": { type: "string" },
  };
  const state = JSON.parse(readFileSync(S.stateFile, "utf8"));
  const current = () => ({ ...defaults, ...state.overrides, "auth.accountPolicies": { value: JSON.parse(readFileSync(S.policyFile, "utf8")), type: "array" } });
  if (args[1] === "list") print(current());
  else if (args[1] === "set") {
    const [key, , , json] = args.slice(2);
    const value = JSON.parse(json);
    if (key === "auth.accountPolicies") writeFileSync(S.policyFile, JSON.stringify(value));
    else if (key === "retry.usageReservePolicy" && !["confirm", "auto", "fail-closed"].includes(value)) fail("invalid enum");
    else { state.overrides[key] = { ...defaults[key], value }; writeFileSync(S.stateFile, JSON.stringify(state)); }
  } else if (args[1] === "reset") {
    if (args[2] === "auth.accountPolicies") writeFileSync(S.policyFile, "[]");
    else { delete state.overrides[args[2]]; writeFileSync(S.stateFile, JSON.stringify(state)); }
  }
} else if (args[0] === "models") {
  print(S.models);
} else if (args[0] === "dry-balance") {
  print(S.balance);
} else {
  fail("unexpected args " + args.join(" "));
}
`;
}

const NOW = Date.now();

function limit(id: string, usedFraction: number) {
  return {
    id,
    label: "5 hours",
    window: { resetsAt: NOW + 3_600_000 },
    amount: { usedFraction },
  };
}

function scenario(pidFile: string, overrides: Partial<Scenario> = {}): Scenario {
  return {
    providers: [
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "openai-codex", name: "ChatGPT", available: true, authenticated: true },
      { id: "openai-codex-device", name: "ChatGPT (device)", available: true, authenticated: true },
      { id: "zai", name: "Z.ai", available: true, authenticated: true },
      { id: "xai", name: "xAI", available: true, authenticated: false },
      { id: "retired", name: "Retired", available: false, authenticated: false },
    ],
    accounts: {
      anthropic: [
        { credentialId: 3, provider: "anthropic", label: "a@example.test (Org A)", type: "oauth" },
        { credentialId: 4, provider: "anthropic", label: "b@example.test (Org B)", type: "oauth" },
      ],
      "openai-codex": [
        { credentialId: 2, provider: "openai-codex", label: "c@example.test", type: "oauth" },
      ],
      // The device-code login lists the same credential as its target.
      "openai-codex-device": [
        { credentialId: 2, provider: "openai-codex", label: "c@example.test", type: "oauth" },
      ],
      zai: [{ credentialId: 9, provider: "zai", label: "key", type: "api_key" }],
    },
    // Reports for Org B come first: the match must follow account ids, not order.
    usage: {
      reports: [
        {
          provider: "anthropic",
          fetchedAt: NOW,
          limits: [limit("anthropic:5h", 0.9)],
          metadata: { accountId: "acc-b" },
        },
        {
          provider: "anthropic",
          fetchedAt: NOW,
          limits: [limit("anthropic:5h", 0.25)],
          metadata: { accountId: "acc-a" },
        },
        {
          provider: "openai-codex",
          fetchedAt: NOW,
          limits: [limit("openai-codex:5h", 0.1)],
          metadata: { accountId: "acc-c" },
        },
      ],
    },
    resets: {
      accounts: [
        {
          provider: "anthropic",
          credentialId: 3,
          accountId: "acc-a",
          availableCount: 0,
          redeemableCount: 0,
        },
        {
          provider: "anthropic",
          credentialId: 4,
          accountId: "acc-b",
          availableCount: 0,
          redeemableCount: 0,
        },
        {
          provider: "openai-codex",
          credentialId: 2,
          accountId: "acc-c",
          availableCount: 2,
          redeemableCount: 0,
          unavailableReason: "cooldown",
          soonestExpiry: "2099-01-01T00:00:00Z",
        },
      ],
    },
    history: { entries: [] },
    models: { models: [{ kind: "chat", selector: "anthropic/model-1" }] },
    balance: {
      model: "anthropic/model-1",
      success: { accounts: [{ account: "a@example.test", percent: 100 }] },
    },
    known: [3, 4],
    redeemable: ["openai-codex/2"],
    policies: [],
    policyFile: "",
    stateFile: "",
    logFile: "",
    pidFile,
    ...overrides,
  };
}

let directory: string;
let pidFile: string;
let policyFile: string;
let stateFile: string;
let logFile: string;
let previousCommand: string | undefined;
const created: OmpAccounts[] = [];

async function install(overrides: Partial<Scenario> = {}): Promise<OmpAccounts> {
  const script = join(directory, "omp");
  await writeFile(policyFile, JSON.stringify(overrides.policies ?? []));
  await writeFile(stateFile, JSON.stringify({ overrides: {} }));
  await writeFile(
    script,
    fakeOmp(scenario(pidFile, { policyFile, stateFile, logFile, ...overrides })),
  );
  await chmod(script, 0o755);
  process.env.OMP_COMMAND = script;
  const accounts = new OmpAccounts();
  created.push(accounts);
  return accounts;
}

// Sign-in state is driven by a real child process's output and `OmpAccounts` exposes no event for
// it, so fake timers cannot advance it; polling the observable state is the only signal.
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function login(view: OmpAccountsView, id: string): OmpLogin | undefined {
  return view.logins.find((entry) => entry.id === id);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-omp-accounts-"));
  pidFile = join(directory, "login.pid");
  policyFile = join(directory, "policies.json");
  stateFile = join(directory, "config-state.json");
  logFile = join(directory, "calls.jsonl");
  previousCommand = process.env.OMP_COMMAND;
});

afterEach(async () => {
  for (const accounts of created.splice(0)) accounts.stop();
  if (previousCommand === undefined) delete process.env.OMP_COMMAND;
  else process.env.OMP_COMMAND = previousCommand;
  await rm(directory, { recursive: true, force: true });
});

describe("listing", () => {
  test("lists each login once, keeps API keys without usage, and offers every available provider", async () => {
    const accounts = await install();
    const view = await accounts.list(undefined, false);

    expect(view.error).toBeNull();
    expect(view.accounts.map((a) => `${a.provider}/${a.credentialId}`)).toEqual([
      "anthropic/3",
      "anthropic/4",
      "openai-codex/2",
      "zai/9",
    ]);
    const key = view.accounts.find((a) => a.provider === "zai");
    expect(key).toMatchObject({ oauth: false, limits: [], resets: null });
    expect(view.providers.map((p) => p.id)).toEqual([
      "anthropic",
      "openai-codex",
      "openai-codex-device",
      "zai",
      "xai",
    ]);
  });

  test("matches usage to each login by account id whatever order the reports come in", async () => {
    const view = await (await install()).list(undefined, false);
    const usedBy = (id: number) =>
      view.accounts.find((a) => a.provider === "anthropic" && a.credentialId === id)?.limits[0]
        ?.usedFraction;

    expect(usedBy(3)).toBe(0.25);
    expect(usedBy(4)).toBe(0.9);
  });

  test("does not guess between same-provider logins it cannot tell apart", async () => {
    const accounts = await install({
      resets: { accounts: [] },
      usage: {
        reports: [
          {
            provider: "anthropic",
            fetchedAt: NOW,
            limits: [limit("anthropic:5h", 0.5)],
            metadata: {},
          },
        ],
      },
    });
    const view = await accounts.list(undefined, false);

    const anthropic = view.accounts.filter((a) => a.provider === "anthropic");
    expect(anthropic).toHaveLength(2);
    expect(anthropic.every((a) => a.limits.length === 0)).toBe(true);
  });

  test("shows OMP's last recorded reading when the provider gave no live one", async () => {
    const recordedAt = NOW - 7 * 60_000;
    const accounts = await install({
      usage: { reports: [] },
      history: {
        entries: [
          {
            recordedAt: recordedAt - 60_000,
            provider: "anthropic",
            accountId: "acc-a",
            limitId: "anthropic:5h",
            label: "5 hours",
            usedFraction: 0.1,
          },
          {
            recordedAt,
            provider: "anthropic",
            accountId: "acc-a",
            limitId: "anthropic:5h",
            label: "5 hours",
            usedFraction: 0.4,
            resetsAt: NOW + 1000,
          },
        ],
      },
    });
    const view = await accounts.list(undefined, false);

    const a = view.accounts.find((entry) => entry.credentialId === 3);
    expect(a).toMatchObject({ usageIsRecorded: true, usageAt: recordedAt });
    expect(a?.limits).toEqual([
      { id: "anthropic:5h", label: "5 hours", usedFraction: 0.4, resetsAt: NOW + 1000 },
    ]);
  });

  test("says why a banked reset cannot be used right now", async () => {
    const view = await (await install()).list(undefined, false);

    const chatgpt = view.accounts.find((a) => a.provider === "openai-codex");
    expect(chatgpt?.resets).toMatchObject({ available: 2, usableNow: false });
    expect(chatgpt?.resets?.blockedReason).toContain("cooldown");
  });

  test("previews where new agents go for providers with several logins only", async () => {
    const view = await (await install()).list(undefined, false);

    expect(view.balance).toEqual([
      {
        provider: "anthropic",
        model: "anthropic/model-1",
        shares: [{ label: "a@example.test", percent: 100 }],
      },
    ]);
  });

  test("keeps the logins when usage output cannot be read and names the failure", async () => {
    const accounts = await install({ usageRaw: "not json" });
    const view = await accounts.list(undefined, false);

    expect(view.accounts).toHaveLength(4);
    expect(view.error).toContain("Usage:");
  });

  test("drops one malformed entry without hiding the rest", async () => {
    const accounts = await install({
      accounts: {
        anthropic: [
          { credentialId: "three", provider: "anthropic", label: "broken", type: "oauth" },
          { credentialId: 4, provider: "anthropic", label: "b@example.test", type: "oauth" },
        ],
      },
    });
    const view = await accounts.list(undefined, false);

    expect(view.accounts.map((a) => a.credentialId)).toEqual([4]);
  });

  test("reports omp as missing instead of failing when it is not installed", async () => {
    process.env.OMP_COMMAND = join(directory, "does-not-exist");
    const accounts = new OmpAccounts();
    const view = await accounts.list(undefined, false);

    expect(view).toMatchObject({ installed: false, accounts: [], providers: [], error: null });
  });
});

describe("sign-in", () => {
  test("reaches the code step with omp's link and prompt, then finishes once omp accepts the code", async () => {
    const accounts = await install();
    const started = await accounts.startLogin(undefined, "anthropic");

    const waiting = await until(
      async () => login(await accounts.list(undefined, false), started.id),
      (entry) => entry?.step === "waiting" && entry.codePrompt !== null,
    );
    expect(waiting).toMatchObject({
      step: "waiting",
      url: "https://example.test/authorize",
      instructions: "Enter code ABCD",
      codePrompt: "Paste the authorization code",
    });

    expect(accounts.submitCode(started.id, "bad").step).toBe("verifying");
    const retry = await until(
      async () => login(await accounts.list(undefined, false), started.id),
      (entry) => entry?.step === "waiting" && entry.message !== null,
    );
    expect(retry?.message).toContain("didn't accept");

    accounts.submitCode(started.id, "good");
    const done = await until(
      async () => login(await accounts.list(undefined, false), started.id),
      (entry) => entry?.step === "done",
    );
    expect(done?.step).toBe("done");
  });

  test("canceling stops the omp process and a later code is refused", async () => {
    const accounts = await install();
    const started = await accounts.startLogin(undefined, "anthropic");
    const waiting = await until(
      async () => login(await accounts.list(undefined, false), started.id),
      (entry) => entry?.step === "waiting",
    );
    expect(waiting?.step).toBe("waiting");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);

    expect(accounts.cancelLogin(started.id)).toMatchObject({ step: "canceled" });
    expect(
      await until(
        async () => alive(pid),
        (running) => !running,
      ),
    ).toBe(false);
    expect(() => accounts.submitCode(started.id, "late")).toThrow(/no longer running/);
  });

  test("a newer sign-in replaces the one still open", async () => {
    const accounts = await install();
    const first = await accounts.startLogin(undefined, "anthropic");
    await accounts.startLogin(undefined, "openai-codex");

    const view = await accounts.list(undefined, false);
    expect(login(view, first.id)).toMatchObject({ step: "canceled" });
  });

  test("sign-ins belong to the store that started them", async () => {
    const accounts = await install();
    await accounts.startLogin({ profile: "work" }, "anthropic");

    expect((await accounts.list(undefined, false)).logins).toEqual([]);
    expect((await accounts.list({ profile: "work" }, false)).logins).toHaveLength(1);
  });
});

describe("caching and isolation", () => {
  async function calls(): Promise<string[][]> {
    const text = await readFile(logFile, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  }
  const usageReads = async () =>
    (await calls()).filter((argv) => argv[0] === "usage" && argv[1] === "--json").length;

  test("a second list within the cache window runs no omp at all", async () => {
    const accounts = await install();
    await accounts.list(undefined, false);
    const before = (await calls()).length;
    await accounts.list(undefined, false);
    expect((await calls()).length).toBe(before);
  });

  test("refresh invalidates omp's usage cache and reads again", async () => {
    const accounts = await install();
    await accounts.list(undefined, false);
    await accounts.list(undefined, true);
    expect((await calls()).some((argv) => argv[0] === "usage" && argv[1] === "invalidate")).toBe(
      true,
    );
    expect(await usageReads()).toBe(2);
  });

  test("concurrent first lists share one read", async () => {
    const accounts = await install();
    await Promise.all([
      accounts.list(undefined, false),
      accounts.list(undefined, false),
      accounts.list(undefined, false),
    ]);
    expect(await usageReads()).toBe(1);
  });

  test("stores are read and cached separately", async () => {
    const accounts = await install();
    await accounts.list(undefined, false);
    await accounts.list({ profile: "work" }, false);
    expect(await usageReads()).toBe(2);
    await accounts.list({ profile: "work" }, false);
    expect(await usageReads()).toBe(2);
  });

  test("when omp stops answering, a refresh keeps the last good listing and names the failure", async () => {
    const accounts = await install();
    const good = await accounts.list(undefined, false);
    expect(good.accounts).toHaveLength(4);
    // Replace the binary with one that breaks; the same instance refreshes against it.
    await writeFile(join(directory, "omp"), "#!/usr/bin/env node\nprocess.exit(3);\n");
    const next = await accounts.list(undefined, true);
    expect(next.accounts).toEqual(good.accounts);
    expect(next.error).toContain("Could not read OMP's accounts");
  });

  test("API-key logins are listed but never steerable", async () => {
    const view = await (await install()).list(undefined, false);
    const key = view.accounts.find((a) => a.provider === "zai");
    expect(key).toMatchObject({ oauth: false, steering: null });
  });

  test("steering writes are serialized so both of two quick changes land", async () => {
    const accounts = await install();
    await Promise.all([
      accounts.setSteering(undefined, "anthropic", 3, { reservePct: 20 }),
      accounts.setSteering(undefined, "anthropic", 4, { reservePct: 30 }),
    ]);
    const policies = JSON.parse(await readFile(policyFile, "utf8")) as Array<{
      reservePct: number;
    }>;
    expect(policies.map((p) => p.reservePct).sort()).toEqual([20, 30]);
  });

  test("a steering change refreshes the listing it came from", async () => {
    const accounts = await install();
    await accounts.list(undefined, false);
    await accounts.setSteering(undefined, "anthropic", 3, { reservePct: 20 });
    const view = await accounts.list(undefined, false);
    expect(view.accounts.find((a) => a.credentialId === 3)?.steering?.reservePct).toBe(20);
  });

  test("stop cancels an open sign-in and kills its process", async () => {
    const accounts = await install();
    const started = await accounts.startLogin(undefined, "anthropic");
    await until(
      async () => login(await accounts.list(undefined, false), started.id),
      (entry) => entry?.step === "waiting",
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    accounts.stop();
    expect(
      await until(
        async () => alive(pid),
        (running) => !running,
      ),
    ).toBe(false);
    expect(login(await accounts.list(undefined, false), started.id)?.step).toBe("canceled");
  });
});

describe("steering", () => {
  async function policies(): Promise<unknown[]> {
    return JSON.parse(await readFile(policyFile, "utf8")) as unknown[];
  }

  test("preferring writes a priority with a reclaim threshold above the default reserve", async () => {
    const accounts = await install();
    await accounts.setSteering(undefined, "anthropic", 3, { preferred: true });

    expect(await policies()).toEqual([
      {
        provider: "anthropic",
        account: { accountId: "acc-a" },
        priority: 100,
        reclaimAbovePct: 25,
      },
    ]);
    const view = await accounts.list(undefined, false);
    expect(view.accounts.find((a) => a.credentialId === 3)?.steering).toEqual({
      preferred: true,
      reservePct: null,
    });
    expect(view.accounts.find((a) => a.credentialId === 4)?.steering).toEqual({
      preferred: false,
      reservePct: null,
    });
  });

  test("at most one preferred login per provider; the reserve moves the reclaim threshold", async () => {
    const accounts = await install();
    await accounts.setSteering(undefined, "anthropic", 3, { preferred: true });
    await accounts.setSteering(undefined, "anthropic", 4, { preferred: true, reservePct: 30 });
    await accounts.setSteering(undefined, "openai-codex", 2, { reservePct: 5 });

    expect(await policies()).toEqual([
      {
        provider: "anthropic",
        account: { accountId: "acc-b" },
        priority: 100,
        reservePct: 30,
        reclaimAbovePct: 45,
      },
      { provider: "openai-codex", account: { accountId: "acc-c" }, reservePct: 5 },
    ]);
  });

  test("dropping the last field resets the setting instead of leaving an empty policy", async () => {
    const accounts = await install();
    await accounts.setSteering(undefined, "anthropic", 3, { preferred: true, reservePct: 20 });
    await accounts.setSteering(undefined, "anthropic", 3, { preferred: false });
    expect(await policies()).toEqual([
      { provider: "anthropic", account: { accountId: "acc-a" }, reservePct: 20 },
    ]);

    await accounts.setSteering(undefined, "anthropic", 3, { reservePct: null });
    expect(await policies()).toEqual([]);
  });

  test("keeps the user's own policy fields and other accounts' policies as written", async () => {
    const accounts = await install({
      policies: [
        { provider: "anthropic", account: { accountId: "acc-b" }, priority: 50, note: "mine" },
        { provider: "other", account: { accountId: "x" }, reservePct: 1 },
      ],
    });
    await accounts.setSteering(undefined, "anthropic", 3, { preferred: true });

    expect(await policies()).toEqual([
      { provider: "anthropic", account: { accountId: "acc-b" }, priority: 50, note: "mine" },
      { provider: "other", account: { accountId: "x" }, reservePct: 1 },
      {
        provider: "anthropic",
        account: { accountId: "acc-a" },
        priority: 100,
        reclaimAbovePct: 25,
      },
    ]);
  });

  test("refuses to steer a login OMP gives no account id for", async () => {
    const accounts = await install({ resets: { accounts: [] } });
    await expect(
      accounts.setSteering(undefined, "anthropic", 3, { preferred: true }),
    ).rejects.toThrow(/doesn't say which account/);
    const view = await accounts.list(undefined, false);
    expect(view.accounts.every((a) => a.steering === null)).toBe(true);
  });

  test("reads OMP's own values for the steering settings and writes one back or resets it", async () => {
    const accounts = await install();
    expect((await accounts.list(undefined, false)).settings).toEqual({
      "retry.usageReservePct": 10,
      "retry.usageReservePolicy": "auto",
      "retry.waitForUsageReset": false,
      "codexResets.autoRedeem": "unset",
    });

    await accounts.setSetting(undefined, "retry.waitForUsageReset", true);
    expect((await accounts.list(undefined, false)).settings["retry.waitForUsageReset"]).toBe(true);
    await accounts.setSetting(undefined, "retry.waitForUsageReset", null);
    expect((await accounts.list(undefined, false)).settings["retry.waitForUsageReset"]).toBe(false);
  });

  test("surfaces OMP's refusal of a setting value", async () => {
    const accounts = await install();
    await expect(
      accounts.setSetting(undefined, "retry.usageReservePolicy", "maybe"),
    ).rejects.toThrow("OMP rejected the change to retry.usageReservePolicy");
  });
});

describe("remove and reset", () => {
  test("removing a login omp does not know surfaces omp's own message and leaves the list alone", async () => {
    const accounts = await install();
    const before = await accounts.list(undefined, false);

    await expect(accounts.remove(undefined, "anthropic", 99_999)).rejects.toThrow(
      "Credential 99999 is not stored for anthropic",
    );
    expect((await accounts.list(undefined, false)).accounts).toEqual(before.accounts);
  });

  test("removing a known login succeeds", async () => {
    const accounts = await install();
    await expect(accounts.remove(undefined, "anthropic", 3)).resolves.toBeUndefined();
  });

  test("refuses a reset omp said it cannot use, without running it", async () => {
    const accounts = await install();
    await accounts.list(undefined, false);

    const result = await accounts.redeem(undefined, "openai-codex", 2);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("cooldown");
  });

  test("spends a usable reset and reports omp's own line", async () => {
    const accounts = await install({
      resets: {
        accounts: [
          {
            provider: "openai-codex",
            credentialId: 2,
            accountId: "acc-c",
            availableCount: 1,
            redeemableCount: 1,
          },
        ],
      },
    });
    await accounts.list(undefined, false);

    expect(await accounts.redeem(undefined, "openai-codex", 2)).toEqual({
      ok: true,
      message: "Used a reset on openai-codex/2",
    });
  });

  test("reports a failed reset without claiming success", async () => {
    const accounts = await install({ redeemable: [] });
    expect(await accounts.redeem(undefined, "openai-codex", 2)).toEqual({
      ok: false,
      message: "OMP could not use the reset",
    });
  });
});
