import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  downloadOmpLocalModelWithDependencies,
  listOmpLocalModelsWithDependencies,
  type OmpLocalModelsDependencies,
  tinyModelPath,
} from "../server/omp-local-models";
import type { BoundedRun } from "../server/provider-diagnostics";
import { withLocalModelRole } from "../shared/omp-local-models";

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
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), `omp-local-models-${randomUUID()}`));
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

  test("assigns and clears a role without touching the others", () => {
    const roles = { default: "a/b", tiny: "online/x" };
    expect(withLocalModelRole(roles, "tiny", "local/falcon-h1-90m")).toEqual({
      default: "a/b",
      tiny: "local/falcon-h1-90m",
    });
    expect(withLocalModelRole(roles, "memory", "local/lfm2-1.2b")).toEqual({
      ...roles,
      memory: "local/lfm2-1.2b",
    });
    expect(withLocalModelRole(roles, "tiny", null)).toEqual({ default: "a/b" });
  });

  test("finds the cache under the agent folder, or under the XDG cache folder for the default agent folder", async () => {
    expect(tinyModelPath("org/repo")).toBe(
      join(process.env.PI_CODING_AGENT_DIR ?? "", "cache", "tiny-models", "org", "repo"),
    );

    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "omp-xdg-"));
    try {
      await mkdir(join(root, "xdg", "omp"), { recursive: true });
      vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
      vi.stubEnv("PASEO_OMP_AGENT_DIR", undefined);
      vi.stubEnv("OMP_AGENT_DIR", undefined);
      vi.stubEnv("OMP_PROFILE", undefined);
      vi.stubEnv("PI_PROFILE", undefined);
      vi.stubEnv("PI_CONFIG_DIR", undefined);
      vi.stubEnv("HOME", join(root, "home"));
      vi.stubEnv("XDG_CACHE_HOME", join(root, "xdg"));
      expect(tinyModelPath("org/repo")).toBe(
        join(root, "xdg", "omp", "cache", "tiny-models", "org", "repo"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
