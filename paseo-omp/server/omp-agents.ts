import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import { type listOmpAgents, OMP_AGENT_LIMIT, type OmpAgent } from "../shared/omp-agents";
import { OmpAgentNameSchema } from "../shared/omp-settings";
import { resolveOmpExecutable } from "./omp-settings";
import { currentOmpEnvironment, ompAgentDir } from "./paths";
import { buildStatefulCommandEnv, defaultSpawn, runBounded } from "./provider-diagnostics";

const UNPACK_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 1_000;
const UNPACK_OUTPUT_LIMIT = 64 * 1024;
const BUNDLED_FAILURE = "Bundled agents could not be listed.";

const UnpackResultSchema = z.object({ written: z.array(z.string()) });

export interface OmpAgentDependencies {
  /** Names of the agents OMP ships with. Rejects when OMP cannot list them. */
  bundledNames(): Promise<string[]>;
  userAgentsDir(): string;
}

function agentNamesFrom(files: readonly string[]): string[] {
  const names: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const name = OmpAgentNameSchema.safeParse(basename(file, ".md"));
    if (name.success) names.push(name.data);
  }
  return names;
}

async function agentNamesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return agentNamesFrom(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * OMP has no agent list command, but `agents unpack` writes the bundled set to a folder. The
 * folder and the whole OMP home are throwaway, so an OMP that ignores `--dir` still writes
 * nothing into the real agent directory.
 */
async function unpackBundledNames(): Promise<string[]> {
  const executable = await resolveOmpExecutable();
  if (!executable) throw new Error("The OMP executable could not be resolved.");
  const scratch = await mkdtemp(join(tmpdir(), "paseo-omp-agents-"));
  try {
    const result = await runBounded(
      defaultSpawn,
      executable,
      ["agents", "unpack", "--dir", join(scratch, "out"), "--json"],
      {
        ...buildStatefulCommandEnv(currentOmpEnvironment()),
        HOME: scratch,
        USERPROFILE: scratch,
        PI_CODING_AGENT_DIR: join(scratch, "agent"),
      },
      UNPACK_TIMEOUT_MS,
      KILL_GRACE_MS,
      UNPACK_OUTPUT_LIMIT,
      scratch,
    );
    if (result.outcome !== "exited" || result.exitCode !== 0 || result.truncated) {
      throw new Error("OMP could not unpack its bundled agents.");
    }
    return agentNamesFrom(UnpackResultSchema.parse(JSON.parse(result.stdout)).written);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const DEFAULT_DEPENDENCIES: OmpAgentDependencies = {
  bundledNames: unpackBundledNames,
  userAgentsDir: () => join(ompAgentDir(), "agents"),
};

export async function listOmpAgentsWithDependencies(
  input: RpcInput<typeof listOmpAgents>,
  dependencies: OmpAgentDependencies,
): Promise<{ agents: OmpAgent[]; error?: string }> {
  // The most specific source wins when a name exists in several places.
  const bySource = new Map<string, OmpAgent["source"]>();
  let error: string | undefined;
  try {
    for (const name of await dependencies.bundledNames()) bySource.set(name, "bundled");
  } catch {
    error = BUNDLED_FAILURE;
  }
  for (const name of await agentNamesIn(dependencies.userAgentsDir())) bySource.set(name, "user");
  if (input.cwd && isAbsolute(input.cwd)) {
    for (const name of await agentNamesIn(join(input.cwd, ".omp", "agents"))) {
      bySource.set(name, "project");
    }
  }
  const agents = [...bySource]
    .map(([name, source]) => ({ name, source }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, OMP_AGENT_LIMIT);
  return error ? { agents, error } : { agents };
}

export function resolveListOmpAgents(input: RpcInput<typeof listOmpAgents>) {
  return listOmpAgentsWithDependencies(input, DEFAULT_DEPENDENCIES);
}
