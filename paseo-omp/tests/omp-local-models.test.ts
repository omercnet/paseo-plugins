import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  downloadOmpLocalModelWithDependencies,
  listOmpLocalModelsWithDependencies,
  type OmpLocalModelsDependencies,
} from "../server/omp-local-models";
import type { BoundedRun } from "../server/provider-diagnostics";

function finished(stdout: string, exitCode = 0): BoundedRun {
  return {
    outcome: "exited",
    stdout,
    truncated: false,
    exitCode,
    signal: null,
    spawnErrorCode: null,
    cleanupFailed: false,
  };
}

const LISTING = JSON.stringify({
  models: [
    {
      key: "lfm2.5-230m",
      repo: "org/lfm",
      label: "LFM2.5 230M",
      description: "Recommended; about 214 MB cached.",
    },
    { key: "llama3.2:3b", repo: "org/llama", label: "Llama 3.2 3B", description: "Larger." },
  ],
});

function harness(downloadResult: Promise<BoundedRun> = Promise.resolve(finished("{}"))) {
  const cached = new Set<string>();
  const runs: string[][] = [];
  const dependencies: OmpLocalModelsDependencies = {
    async resolveExecutable() {
      return "/fake/omp";
    },
    async run(_executable, args) {
      runs.push([...args]);
      return args[1] === "list" ? finished(LISTING) : downloadResult;
    },
    async isCached(repo) {
      return cached.has(repo);
    },
  };
  return { cached, runs, dependencies };
}

beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", `/tmp/omp-local-models-${Math.random()}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OMP local models", () => {
  test("lists OMP's models with the size it names and whether they are cached", async () => {
    const { cached, dependencies } = harness();
    cached.add("org/lfm");

    const listed = await listOmpLocalModelsWithDependencies(dependencies);

    expect(listed.available).toBe(true);
    expect(listed.models).toEqual([
      expect.objectContaining({ key: "lfm2.5-230m", sizeMb: 214, downloaded: true }),
      expect.objectContaining({ key: "llama3.2:3b", sizeMb: null, downloaded: false }),
    ]);
  });

  test("reports unavailable when OMP cannot list or prints something else", async () => {
    const { dependencies } = harness();
    const broken = { ...dependencies, run: async () => finished("not json") };
    expect(await listOmpLocalModelsWithDependencies(broken)).toEqual({
      available: false,
      models: [],
    });
    const missing = { ...dependencies, resolveExecutable: async () => null };
    expect((await listOmpLocalModelsWithDependencies(missing)).available).toBe(false);
  });

  test("downloads one listed model at a time and tracks the outcome", async () => {
    const result = Promise.withResolvers<BoundedRun>();
    const { cached, runs, dependencies } = harness(result.promise);

    expect(
      await downloadOmpLocalModelWithDependencies({ key: "not-a-model" }, dependencies),
    ).toEqual({ outcome: "unknown-model" });
    expect(runs.some((args) => args[1] === "download")).toBe(false);

    expect(
      await downloadOmpLocalModelWithDependencies({ key: "lfm2.5-230m" }, dependencies),
    ).toEqual({ outcome: "started" });
    expect(runs).toContainEqual(["tiny-models", "download", "lfm2.5-230m", "--json"]);
    expect(
      await downloadOmpLocalModelWithDependencies({ key: "llama3.2:3b" }, dependencies),
    ).toEqual({ outcome: "busy" });
    const running = await listOmpLocalModelsWithDependencies(dependencies);
    expect(running.models[0]?.download).toBe("running");

    cached.add("org/lfm");
    result.resolve(finished(JSON.stringify({ results: [{ model: "lfm2.5-230m", ok: true }] })));
    await vi.waitFor(async () => {
      const done = await listOmpLocalModelsWithDependencies(dependencies);
      expect(done.models[0]).toMatchObject({ download: "idle", downloaded: true });
    });
  });

  test("keeps a failed download visible without echoing OMP's output, and allows a retry", async () => {
    const { dependencies } = harness(Promise.resolve(finished("secret token in output", 1)));

    await downloadOmpLocalModelWithDependencies({ key: "llama3.2:3b" }, dependencies);
    await vi.waitFor(async () => {
      const listed = await listOmpLocalModelsWithDependencies(dependencies);
      expect(listed.models[1]).toMatchObject({ download: "failed" });
      expect(JSON.stringify(listed)).not.toContain("secret token");
    });

    expect(
      await downloadOmpLocalModelWithDependencies({ key: "llama3.2:3b" }, dependencies),
    ).toEqual({ outcome: "started" });
  });
});
