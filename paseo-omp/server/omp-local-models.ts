import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import type { downloadOmpLocalModel, listOmpLocalModels } from "../shared/omp-local-models";
import { resolveOmpExecutable } from "./omp-settings";
import { currentOmpEnvironment, ompAgentDir } from "./paths";
import {
  type BoundedRun,
  buildStatefulCommandEnv,
  defaultSpawn,
  runBounded,
} from "./provider-diagnostics";

const LIST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const ListedModelsSchema = z.object({
  models: z.array(
    z.object({
      key: z.string(),
      repo: z.string(),
      label: z.string(),
      description: z.string(),
    }),
  ),
});

const DownloadResultSchema = z.object({ results: z.array(z.object({ ok: z.boolean() })) });

export interface OmpLocalModelsDependencies {
  resolveExecutable(): Promise<string | null>;
  run(executable: string, args: readonly string[], timeoutMs: number): Promise<BoundedRun>;
  /** True when OMP's cache folder already holds the model's repository. */
  isCached(repo: string): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: OmpLocalModelsDependencies = {
  resolveExecutable: resolveOmpExecutable,
  run: (executable, args, timeoutMs) =>
    runBounded(
      defaultSpawn,
      executable,
      args,
      buildStatefulCommandEnv(currentOmpEnvironment()),
      timeoutMs,
      KILL_GRACE_MS,
      MAX_OUTPUT_BYTES,
      tmpdir(),
    ),
  async isCached(repo) {
    try {
      return (
        await stat(join(ompAgentDir(), "cache", "tiny-models", ...repo.split("/")))
      ).isDirectory();
    } catch {
      return false;
    }
  },
};

interface Job {
  state: "running" | "failed";
  error: string | null;
}

/** Download progress lives here because a download outlasts the request that started it. */
const jobs = new Map<string, Job>();

function jobKey(key: string): string {
  return `${ompAgentDir()}\0${key}`;
}

function anyRunning(): boolean {
  const prefix = `${ompAgentDir()}\0`;
  return [...jobs].some(([key, job]) => key.startsWith(prefix) && job.state === "running");
}

function sizeFrom(description: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*MB/u.exec(description);
  return match?.[1] ? Math.round(Number(match[1])) : null;
}

async function listModels(executable: string, dependencies: OmpLocalModelsDependencies) {
  const result = await dependencies.run(
    executable,
    ["tiny-models", "list", "--json"],
    LIST_TIMEOUT_MS,
  );
  if (result.outcome !== "exited" || result.exitCode !== 0 || result.truncated) return null;
  try {
    const parsed = ListedModelsSchema.safeParse(JSON.parse(result.stdout));
    return parsed.success ? parsed.data.models : null;
  } catch {
    return null;
  }
}

export async function listOmpLocalModelsWithDependencies(
  dependencies: OmpLocalModelsDependencies,
): Promise<RpcOutput<typeof listOmpLocalModels>> {
  const executable = await dependencies.resolveExecutable();
  const listed = executable ? await listModels(executable, dependencies) : null;
  if (!listed) return { available: false, models: [] };
  const models = await Promise.all(
    listed.map(async (model) => {
      const job = jobs.get(jobKey(model.key));
      return {
        key: model.key,
        label: model.label,
        description: model.description,
        sizeMb: sizeFrom(model.description),
        downloaded: await dependencies.isCached(model.repo),
        download: job?.state ?? ("idle" as const),
        error: job?.error ?? null,
      };
    }),
  );
  return { available: true, models };
}

function finishDownload(name: string, result: BoundedRun): void {
  const parsed = (() => {
    try {
      return DownloadResultSchema.safeParse(JSON.parse(result.stdout));
    } catch {
      return null;
    }
  })();
  const ok =
    result.outcome === "exited" &&
    result.exitCode === 0 &&
    parsed?.success === true &&
    parsed.data.results.every((entry) => entry.ok);
  if (ok) {
    jobs.delete(name);
    return;
  }
  jobs.set(name, {
    state: "failed",
    error: result.outcome === "timeout" ? "The download timed out." : "OMP could not download it.",
  });
}

export async function downloadOmpLocalModelWithDependencies(
  input: RpcInput<typeof downloadOmpLocalModel>,
  dependencies: OmpLocalModelsDependencies,
): Promise<RpcOutput<typeof downloadOmpLocalModel>> {
  const executable = await dependencies.resolveExecutable();
  if (!executable) return { outcome: "unavailable" };
  const listed = await listModels(executable, dependencies);
  if (!listed) return { outcome: "unavailable" };
  if (!listed.some((model) => model.key === input.key)) return { outcome: "unknown-model" };
  if (anyRunning()) return { outcome: "busy" };

  const name = jobKey(input.key);
  jobs.set(name, { state: "running", error: null });
  void dependencies
    .run(executable, ["tiny-models", "download", input.key, "--json"], DOWNLOAD_TIMEOUT_MS)
    .then((result) => finishDownload(name, result));
  return { outcome: "started" };
}

export function resolveListOmpLocalModels() {
  return listOmpLocalModelsWithDependencies(DEFAULT_DEPENDENCIES);
}

export function resolveDownloadOmpLocalModel(input: RpcInput<typeof downloadOmpLocalModel>) {
  return downloadOmpLocalModelWithDependencies(input, DEFAULT_DEPENDENCIES);
}
