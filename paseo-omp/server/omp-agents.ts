import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type listOmpAgents, OMP_AGENT_LIMIT, type OmpAgent } from "../shared/omp-agents";
import { OmpAgentNameSchema } from "../shared/omp-settings";
import { resolveOmpExecutable } from "./omp-settings";
import { currentOmpEnvironment, ompAgentDir } from "./paths";
import { buildStatefulCommandEnv, defaultSpawn, runBounded } from "./provider-diagnostics";

const UNPACK_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 1_000;
const UNPACK_OUTPUT_LIMIT = 64 * 1024;
const AGENT_FILE_LIMIT = 256 * 1024;
const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/u;
const BUNDLED_FAILURE = "Bundled agents could not be listed.";

/** Everything OMP would use to relocate its config, data, state, cache or agent directory. */
const OMP_LOCATION_ENV = [
  "OMP_AGENT_DIR",
  "OMP_PROFILE",
  "OMP_SESSION_DIR",
  "PASEO_OMP_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

const UnpackResultSchema = z.object({ written: z.array(z.string()) });

export interface OmpAgentDependencies {
  /** Names of the agents OMP ships with. Rejects when OMP cannot list them. */
  bundledNames(): Promise<string[]>;
  userAgentsDir(): string;
}

/** The name OMP registers for an agent file: its frontmatter `name`, which needs a `description`. */
async function agentNameFromFile(path: string): Promise<string | null> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > AGENT_FILE_LIMIT) return null;
  const frontmatter = FRONTMATTER.exec(await readFile(path, "utf8"));
  if (!frontmatter?.[1]) return null;
  let fields: unknown;
  try {
    fields = parseYaml(frontmatter[1]);
  } catch {
    return null;
  }
  if (fields === null || typeof fields !== "object") return null;
  const { name, description } = fields as Record<string, unknown>;
  if (typeof description !== "string" || description.length === 0) return null;
  const parsed = OmpAgentNameSchema.safeParse(typeof name === "string" ? name.trim() : name);
  return parsed.success ? parsed.data : null;
}

async function agentNamesFrom(paths: readonly string[]): Promise<string[]> {
  const names: string[] = [];
  for (const path of paths.slice(0, OMP_AGENT_LIMIT)) {
    if (!path.endsWith(".md")) continue;
    const name = await agentNameFromFile(path).catch(() => null);
    if (name) names.push(name);
  }
  return names;
}

async function agentNamesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return agentNamesFrom(
      entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** A scratch-only OMP environment: nothing inherited can point OMP at a real directory. */
export function scratchOmpEnvironment(base: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const key of OMP_LOCATION_ENV) delete environment[key];
  return {
    ...environment,
    HOME: scratch,
    USERPROFILE: scratch,
    PI_CODING_AGENT_DIR: join(scratch, "agent"),
  };
}

/**
 * OMP has no agent list command, but `agents unpack` writes the bundled set to a folder. The
 * folder and the whole OMP home are throwaway, so an OMP that ignores `--dir` still writes
 * nothing into a real agent directory.
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
      scratchOmpEnvironment(buildStatefulCommandEnv(currentOmpEnvironment()), scratch),
      UNPACK_TIMEOUT_MS,
      KILL_GRACE_MS,
      UNPACK_OUTPUT_LIMIT,
      scratch,
    );
    if (result.outcome !== "exited" || result.exitCode !== 0 || result.truncated) {
      throw new Error("OMP could not unpack its bundled agents.");
    }
    const { written } = UnpackResultSchema.parse(JSON.parse(result.stdout));
    const inside = written.filter((path) => {
      const within = relative(scratch, path);
      return isAbsolute(path) && !within.startsWith("..") && !isAbsolute(within);
    });
    return await agentNamesFrom(inside);
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
