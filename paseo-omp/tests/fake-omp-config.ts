import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { OmpListDependencies } from "../server/omp-list-setting";
import type { BoundedRun } from "../server/provider-diagnostics";

const SCRATCH_PREFIX = join(tmpdir(), "paseo-omp-rules-");

export function exited(stdout: string): BoundedRun {
  return {
    outcome: "exited",
    stdout,
    truncated: false,
    exitCode: 0,
    signal: null,
    spawnErrorCode: null,
    cleanupFailed: false,
  };
}

export const ProjectConfigSchema = z
  .object({
    skills: z.object({ ignoredSkills: z.array(z.string()).optional() }).optional(),
    disabledExtensions: z.array(z.string()).optional(),
  })
  .nullable();

export type ListName = "skills.ignoredSkills" | "disabledExtensions";

function readProject(text: string) {
  try {
    return ProjectConfigSchema.parse(parseYaml(text) ?? null);
  } catch {
    return null;
  }
}

/**
 * A stand-in for omp: a user config plus the project `.omp/config.yml` that replaces its lists.
 * `removeDir` only ever deletes a scratch directory or something under `deletableRoot`.
 */
export function fakeOmp(
  skills: unknown[],
  user: Partial<Record<ListName, string[]>> = {},
  deletableRoot?: string,
) {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const userConfig: Record<ListName, string[]> = {
    "skills.ignoredSkills": [],
    disabledExtensions: [],
    ...user,
  };
  const dependencies: OmpListDependencies = {
    resolveExecutable: async () => "/usr/bin/omp",
    run: async (_executable, args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === "skill") return exited(JSON.stringify({ skills, warnings: [] }));
      const list: ListName =
        args[2] === "disabledExtensions" ? "disabledExtensions" : "skills.ignoredSkills";
      if (args[1] === "set") {
        userConfig[list] = z.array(z.string()).parse(JSON.parse(args[5] ?? "[]"));
        return exited("{}");
      }
      const projectFile = join(cwd, ".omp", "config.yml");
      const projectText = existsSync(projectFile) ? await readFile(projectFile, "utf8") : "";
      const project = readProject(projectText);
      const projectList =
        list === "skills.ignoredSkills"
          ? project?.skills?.ignoredSkills
          : project?.disabledExtensions;
      return exited(JSON.stringify({ value: projectList ?? userConfig[list] }));
    },
    validateProjectConfig: async () => exited("{}"),
    makeScratchDir: (prefix) => mkdtemp(prefix),
    removeDir: async (path) => {
      const inRoot = deletableRoot !== undefined && path.startsWith(deletableRoot + sep);
      if (path.startsWith(SCRATCH_PREFIX) || inRoot) {
        await rm(path, { recursive: true, force: true });
      }
    },
  };
  return { calls, userConfig, dependencies };
}
