import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getOmpModelsFileStatusWithDependencies,
  modelsEnvironment,
  type OmpModelsDependencies,
  parseOmpModelsWarning,
  refreshOmpModelsWithDependencies,
} from "../server/omp-models-file";
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

const INVALID_SCHEMA =
  "Warning: models.yml validation failed \u2014 custom providers disabled\n" +
  'Failed to load config file models, Validate(models) error: Provider broken, model m1: no "api" specified. Set at provider or model level.\n';
const INVALID_YAML =
  "Warning: models.yml validation failed \u2014 custom providers disabled\n" +
  "Failed to load config file models, Unexpected error: YAML Parse error: Unexpected token\n";

function fakeOmp(answer: BoundedRun | null) {
  const calls: { args: readonly string[]; stderrLimit: number; providerEnvironment: boolean }[] =
    [];
  const dependencies: OmpModelsDependencies = {
    resolveExecutable: async () => (answer ? "/usr/bin/omp" : null),
    run: async (_executable, args, _timeoutMs, stderrLimit, providerEnvironment) => {
      calls.push({ args, stderrLimit, providerEnvironment });
      return answer ?? run();
    },
  };
  return { calls, dependencies };
}

describe("parseOmpModelsWarning", () => {
  test("reports ok when omp printed no models.yml warning", () => {
    expect(parseOmpModelsWarning("")).toEqual({ state: "ok" });
    expect(parseOmpModelsWarning("some unrelated warning\n")).toEqual({ state: "ok" });
  });

  test("reports the schema error that made omp drop custom providers", () => {
    expect(parseOmpModelsWarning(INVALID_SCHEMA)).toEqual({
      state: "invalid",
      detail: 'Provider broken, model m1: no "api" specified. Set at provider or model level.',
    });
  });

  test("reports a YAML syntax error", () => {
    expect(parseOmpModelsWarning(INVALID_YAML)).toEqual({
      state: "invalid",
      detail: "YAML Parse error: Unexpected token",
    });
  });

  test("still reports invalid when omp words the detail differently", () => {
    expect(
      parseOmpModelsWarning(
        "Warning: models.yml validation failed \u2014 custom providers disabled\n",
      ),
    ).toEqual({ state: "invalid", detail: "OMP could not load it" });
  });

  test("reports omp's schema error without echoing the offending value", () => {
    const status = parseOmpModelsWarning(
      "Warning: models.yml validation failed \u2014 custom providers disabled\n" +
        'Failed to load config file models, Schema error: providers.p.api: must be "openai-completions" or "typesafe" (was "SECRETAPI-sk-abc")\n',
    );
    expect(status).toEqual({
      state: "invalid",
      detail: 'providers.p.api: must be "openai-completions" or "typesafe"',
    });
  });

  test("joins the bullet lines of a multi-problem schema error and drops their values", () => {
    const status = parseOmpModelsWarning(
      "Warning: models.yml validation failed \u2014 custom providers disabled\n" +
        "Failed to load config file models, Schema error:\n" +
        "  - providers.p.baseUrl: must be a string (was sk-LEAKED)\n" +
        "  - providers.p.models: must be an array (was a string)\n" +
        "some later line\n",
    );
    expect(status).toEqual({
      state: "invalid",
      detail: "providers.p.baseUrl: must be a string; providers.p.models: must be an array",
    });
  });

  test("bounds the detail and strips control characters", () => {
    const noisy = `${"x".repeat(1000)}\u001b[31m`;
    const status = parseOmpModelsWarning(
      `Warning: models.yml validation failed\nFailed to load config file models, Unexpected error: ${noisy}\n`,
    );
    expect(status.state).toBe("invalid");
    if (status.state !== "invalid") return;
    expect(status.detail.length).toBeLessThanOrEqual(300);
    expect(status.detail).not.toContain("\u001b");
  });
});

describe("models.yml status", () => {
  test("asks omp for the model list with stderr, never to refresh", async () => {
    const { calls, dependencies } = fakeOmp(run({ stderr: "" }));
    await getOmpModelsFileStatusWithDependencies(dependencies);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["models", "--json", "--no-extensions"]);
    expect(calls[0]?.stderrLimit).toBeGreaterThan(0);
    expect(calls[0]?.providerEnvironment).toBe(false);
  });

  test("reports invalid from the stderr of a successful run", async () => {
    const { dependencies } = fakeOmp(run({ stdout: '{"models":[]}', stderr: INVALID_SCHEMA }));
    await expect(getOmpModelsFileStatusWithDependencies(dependencies)).resolves.toMatchObject({
      state: "invalid",
    });
  });

  test.each([
    ["omp exits non-zero", run({ exitCode: 1, stderr: INVALID_SCHEMA })],
    ["the run times out", run({ outcome: "timeout", exitCode: null })],
  ])("reports unknown when %s", async (_name, answer) => {
    const { dependencies } = fakeOmp(answer);
    await expect(getOmpModelsFileStatusWithDependencies(dependencies)).resolves.toEqual({
      state: "unknown",
    });
  });

  test("reports unknown when omp cannot be found", async () => {
    const { dependencies } = fakeOmp(null);
    await expect(getOmpModelsFileStatusWithDependencies(dependencies)).resolves.toEqual({
      state: "unknown",
    });
  });
});

describe("refresh models", () => {
  test("runs omp models refresh without collecting stderr", async () => {
    const { calls, dependencies } = fakeOmp(run());
    await expect(refreshOmpModelsWithDependencies(dependencies)).resolves.toMatchObject({
      ok: true,
    });
    expect(calls).toEqual([
      { args: ["models", "refresh", "--no-extensions"], stderrLimit: 0, providerEnvironment: true },
    ]);
  });

  test("reports a timeout distinctly", async () => {
    const { dependencies } = fakeOmp(run({ outcome: "timeout", exitCode: null }));
    const result = await refreshOmpModelsWithDependencies(dependencies);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("too long");
  });

  test("refuses when omp cannot be found", async () => {
    const { dependencies } = fakeOmp(null);
    await expect(refreshOmpModelsWithDependencies(dependencies)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("models environment", () => {
  beforeEach(() => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("OPENAI_API_KEY", "sk-from-daemon");
    vi.stubEnv("GITHUB_TOKEN", "ghp-unrelated");
    vi.stubEnv("NODE_OPTIONS", "--require /tmp/evil.js");
    vi.stubEnv("MY_GATEWAY_KEY", "gw-inherited");
  });
  afterEach(() => vi.unstubAllEnvs());

  test("a refresh gets the provider API keys so hosted catalogs answer", () => {
    expect(modelsEnvironment(true).OPENAI_API_KEY).toBe("sk-from-daemon");
    expect(modelsEnvironment(true).PATH).toBe("/usr/bin");
  });

  test("a refresh never gets unrelated daemon secrets or loader controls", () => {
    const env = modelsEnvironment(true);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  test("a refresh gets the names the host chose to inherit, and only those", () => {
    expect(modelsEnvironment(true, ["MY_GATEWAY_KEY"]).MY_GATEWAY_KEY).toBe("gw-inherited");
    expect(modelsEnvironment(true).MY_GATEWAY_KEY).toBeUndefined();
  });

  test("the models.yml check never gets provider keys", () => {
    expect(modelsEnvironment(false).OPENAI_API_KEY).toBeUndefined();
    expect(modelsEnvironment(false).PATH).toBe("/usr/bin");
  });
});
