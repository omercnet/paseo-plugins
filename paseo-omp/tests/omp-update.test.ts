import { delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createOmpUpdateService,
  type OmpUpdateDependencies,
  parseOmpUpdateCheck,
  updateEnvironment,
} from "../server/omp-update";
import type { BoundedRun } from "../server/provider-diagnostics";

function run(overrides: Partial<BoundedRun> = {}): BoundedRun {
  return {
    outcome: "exited",
    stdout: "",
    truncated: false,
    exitCode: 0,
    signal: null,
    spawnErrorCode: null,
    cleanupFailed: false,
    ...overrides,
  };
}

const BEHIND = "Current version: 18.13.1\nNew version available: 18.16.0\n";
const CURRENT = "Current version: 18.16.0\n\u2714 Already up to date\n";
const MINUTE = 60_000;

/** Answers each omp call from a queue (a function answer can defer) and records the arguments. */
function fakeOmp(...answers: (BoundedRun | (() => Promise<BoundedRun>))[]) {
  const calls: (readonly string[])[] = [];
  let time = 0;
  const dependencies: OmpUpdateDependencies = {
    resolveExecutable: async () => "/usr/bin/omp",
    run: async (_executable, args) => {
      calls.push(args);
      const answer = answers.shift() ?? run();
      return typeof answer === "function" ? answer() : answer;
    },
  };
  const service = createOmpUpdateService(dependencies, () => time);
  return {
    calls,
    service,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function deferred() {
  const { promise, resolve } = Promise.withResolvers<BoundedRun>();
  return { promise, resolve };
}

describe("parseOmpUpdateCheck", () => {
  test("reads the newer version omp announces", () => {
    expect(parseOmpUpdateCheck(BEHIND)).toEqual({ state: "available", version: "18.16.0" });
  });

  test("reads a canary version with a prerelease tag", () => {
    expect(parseOmpUpdateCheck("New version available: 18.17.0-canary.4\n")).toEqual({
      state: "available",
      version: "18.17.0-canary.4",
    });
  });

  test("reads the version from CRLF output", () => {
    expect(parseOmpUpdateCheck("New version available: 18.16.0\r\n")).toEqual({
      state: "available",
      version: "18.16.0",
    });
  });

  test("reads omp's already-up-to-date line", () => {
    expect(parseOmpUpdateCheck(CURRENT)).toEqual({ state: "up-to-date" });
  });

  test("never guesses from output it does not understand", () => {
    expect(parseOmpUpdateCheck("")).toEqual({ state: "unknown" });
    expect(parseOmpUpdateCheck("brew is installed and kept up to date by brew")).toEqual({
      state: "unknown",
    });
    expect(parseOmpUpdateCheck("New version available: latest; rm -rf /")).toEqual({
      state: "unknown",
    });
  });
});

describe("update status", () => {
  test("asks omp only to check, never to install", async () => {
    const { calls, service } = fakeOmp(run({ stdout: BEHIND }));
    await service.status({});
    expect(calls).toEqual([["update", "--check"]]);
  });

  test("reuses a recent answer until it expires or is forced", async () => {
    const { calls, service, advance } = fakeOmp(
      run({ stdout: BEHIND }),
      run({ stdout: CURRENT }),
      run({ stdout: BEHIND }),
    );
    const first = await service.status({});
    advance(MINUTE);
    expect(await service.status({})).toEqual(first);
    expect(calls).toHaveLength(1);

    expect(await service.status({ force: true })).toEqual({ state: "up-to-date" });
    advance(11 * MINUTE);
    expect(await service.status({})).toEqual({ state: "available", version: "18.16.0" });
    expect(calls).toHaveLength(3);
  });

  test("shares one network check between concurrent callers", async () => {
    const pending = deferred();
    const { calls, service } = fakeOmp(() => pending.promise);
    const first = service.status({});
    const second = service.status({});
    pending.resolve(run({ stdout: BEHIND }));
    expect(await first).toEqual(await second);
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["omp exits non-zero (offline)", run({ exitCode: 1, stdout: BEHIND })],
    ["the check times out", run({ outcome: "timeout", exitCode: null, stdout: BEHIND })],
    ["output is truncated", run({ truncated: true, stdout: BEHIND })],
  ])("reports unknown when %s, and asks again next time", async (_name, failure) => {
    const { calls, service } = fakeOmp(failure, run({ stdout: BEHIND }));
    expect(await service.status({})).toEqual({ state: "unknown" });
    expect(await service.status({})).toEqual({ state: "available", version: "18.16.0" });
    expect(calls).toHaveLength(2);
  });

  test("reports unknown when omp cannot be found", async () => {
    const service = createOmpUpdateService({
      resolveExecutable: async () => null,
      run: async () => {
        throw new Error("must not run");
      },
    });
    await expect(service.status({ force: true })).resolves.toEqual({ state: "unknown" });
  });
});

describe("install update", () => {
  test("updates, then re-checks so the new state is what the caller sees", async () => {
    const { calls, service } = fakeOmp(run(), run({ stdout: CURRENT }));
    const result = await service.install();
    expect(calls).toEqual([["update"], ["update", "--check"]]);
    expect(result.ok).toBe(true);
    expect(result.status).toEqual({ state: "up-to-date" });
    expect(result.message).toContain("restart");
  });

  test("does not claim success when omp exits 0 but is still behind (package-manager install)", async () => {
    const { service } = fakeOmp(
      run({ stdout: "omp is installed and kept up to date by brew; update it from brew." }),
      run({ stdout: BEHIND }),
    );
    const result = await service.install();
    expect(result.ok).toBe(false);
    expect(result.status).toEqual({ state: "available", version: "18.16.0" });
    expect(result.message).toContain("package manager");
  });

  test("says the new version is unconfirmed when the re-check cannot run", async () => {
    const { service } = fakeOmp(run(), run({ exitCode: 1 }));
    const result = await service.install();
    expect(result.status).toEqual({ state: "unknown" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unconfirmed");
    expect(result.message).not.toContain("updated.");
  });

  test("reports a failed update without echoing omp's output", async () => {
    const { service } = fakeOmp(
      run({ exitCode: 1, stdout: "Update failed: /home/someone/secret" }),
      run({ stdout: BEHIND }),
    );
    const result = await service.install();
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("secret");
  });

  test("reports a timed-out update as possibly incomplete", async () => {
    const { service } = fakeOmp(run({ outcome: "timeout", exitCode: null }), run());
    const result = await service.install();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("incomplete");
  });

  test("a check that finishes after the install cannot overwrite the new status", async () => {
    const slowCheck = deferred();
    const { service } = fakeOmp(() => slowCheck.promise, run(), run({ stdout: CURRENT }));
    const staleCheck = service.status({});
    const installed = await service.install();
    expect(installed.status).toEqual({ state: "up-to-date" });

    slowCheck.resolve(run({ stdout: BEHIND }));
    expect(await staleCheck).toEqual({ state: "available", version: "18.16.0" });
    expect(await service.status({})).toEqual({ state: "up-to-date" });
  });

  test("refuses to run when omp cannot be found", async () => {
    const service = createOmpUpdateService({
      resolveExecutable: async () => null,
      run: async () => {
        throw new Error("must not run");
      },
    });
    await expect(service.install()).resolves.toMatchObject({
      ok: false,
      status: { state: "unknown" },
    });
  });
});

describe("update environment", () => {
  beforeEach(() => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:3128");
    vi.stubEnv("BUN_INSTALL", "/opt/bun");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/ca.pem");
    vi.stubEnv("OPENAI_API_KEY", "sk-secret");
    vi.stubEnv("GITHUB_TOKEN", "ghp-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  test("puts the executable's directory first so omp updates the install it was asked about", () => {
    const env = updateEnvironment("/opt/custom/bin/omp");
    expect(env.PATH).toBe(["/opt/custom/bin", "/usr/bin"].join(delimiter));
  });

  test("forwards network and install-root settings, never credentials", () => {
    const env = updateEnvironment("/usr/bin/omp");
    expect(env.HTTPS_PROXY).toBe("http://proxy.test:3128");
    expect(env.BUN_INSTALL).toBe("/opt/bun");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
  });
});
