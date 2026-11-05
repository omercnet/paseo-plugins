import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type {
  deleteOmpManagedSkill,
  listOmpSkills,
  OmpSkill,
  OmpSkillList,
  OmpSkillOff,
  OmpSkillsList,
  setOmpSkillEnabled,
} from "../shared/omp-skills";
import { SKILL_ENTRY_PREFIX } from "../shared/omp-skills";
import {
  inOmpScope,
  type OmpRulesDependencies,
  ompCommandDependencies,
  readSetting,
  runJson,
} from "./omp-rules";
import {
  type OmpSettingsDependencies,
  ompSettingsDependencies,
  readProjectConfigText,
  runSettingsMutation,
  writeProjectChanges,
} from "./omp-settings";
import { ompAgentDir } from "./paths";
import { OmpPublicError } from "./provider/security";

const MAX_SKILLS = 500;
const MAX_OFF_ENTRIES = 200;
const MAX_TEXT_CHARS = 2_000;
const MANAGED_SOURCE = "omp-managed";
const UNREADABLE_CONFIG = "The workspace OMP configuration could not be read";

export class OmpSkillsError extends OmpPublicError {}

export interface OmpSkillsDependencies extends OmpRulesDependencies {
  validateProjectConfig: OmpSettingsDependencies["validateProjectConfig"];
}

/** One entry of `omp skill list --json`. */
const SkillEntrySchema = z.object({
  name: z.string().min(1).max(256),
  description: z
    .string()
    .nullish()
    .transform((text) => (text ?? "").slice(0, MAX_TEXT_CHARS)),
  baseDir: z.string().min(1).max(4_096),
  source: z.string().min(1).max(128),
});
const SkillListSchema = z.object({ skills: z.array(z.unknown()) });
const ListSettingSchema = z.object({ value: z.array(z.string()) });

/** A source reads `<provider>:<level>`, such as `native:project` or `omp-managed:user`. */
function toSkill(entry: z.infer<typeof SkillEntrySchema>): OmpSkill {
  const split = entry.source.lastIndexOf(":");
  const provider = split < 0 ? entry.source : entry.source.slice(0, split);
  const scope = split < 0 ? "" : entry.source.slice(split + 1);
  return {
    name: entry.name,
    description: entry.description,
    source: provider,
    level: scope === "project" || scope === "user" ? scope : "other",
    path: entry.baseDir,
    managed: provider === MANAGED_SOURCE,
  };
}

async function listSkills(
  dependencies: OmpSkillsDependencies,
  executable: string,
  runIn: string,
): Promise<OmpSkill[]> {
  const raw = await runJson(dependencies, executable, ["skill", "list", "--json"], runIn);
  const parsed = SkillListSchema.safeParse(raw);
  if (!parsed.success) throw new OmpSkillsError("omp skill list gave output the plugin can't read");
  return parsed.data.skills.slice(0, MAX_SKILLS).flatMap((entry) => {
    const skill = SkillEntrySchema.safeParse(entry);
    return skill.success ? [toSkill(skill.data)] : [];
  });
}

function readList(
  dependencies: OmpSkillsDependencies,
  executable: string,
  list: OmpSkillList,
  runIn: string,
): Promise<string[]> {
  return readSetting(dependencies, executable, list, ListSettingSchema, runIn);
}

/** OMP trims each entry. Only `skill:` entries of `disabledExtensions` concern skills. */
function offEntries(ignored: readonly string[], extensions: readonly string[]): OmpSkillOff[] {
  const entries: OmpSkillOff[] = [
    ...ignored.map((entry) => ({ list: "skills.ignoredSkills" as const, entry: entry.trim() })),
    ...extensions
      .map((entry) => entry.trim())
      .filter(
        (entry) => entry.startsWith(SKILL_ENTRY_PREFIX) && entry.length > SKILL_ENTRY_PREFIX.length,
      )
      .map((entry) => ({ list: "disabledExtensions" as const, entry })),
  ];
  const seen = new Set<string>();
  return entries
    .filter(({ list, entry }) => {
      const key = `${list}\0${entry}`;
      if (entry === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_OFF_ENTRIES)
    .map(({ list, entry }) => ({ list, entry: entry.slice(0, MAX_TEXT_CHARS) }));
}

async function requireExecutable(dependencies: OmpSkillsDependencies): Promise<string> {
  const executable = await dependencies.resolveExecutable();
  if (!executable) throw new OmpSkillsError("The omp command was not found on this host");
  return executable;
}

export async function listOmpSkillsWithDependencies(
  input: RpcInput<typeof listOmpSkills>,
  dependencies: OmpSkillsDependencies,
): Promise<OmpSkillsList> {
  try {
    const executable = await requireExecutable(dependencies);
    return await inOmpScope(input.cwd, dependencies, async (runIn) => {
      const [skills, ignored, extensions] = await Promise.all([
        listSkills(dependencies, executable, runIn),
        readList(dependencies, executable, "skills.ignoredSkills", runIn),
        readList(dependencies, executable, "disabledExtensions", runIn),
      ]);
      return { status: "ready" as const, skills, off: offEntries(ignored, extensions) };
    });
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

/**
 * A project list replaces the user list, so a workspace edit starts from the effective list and
 * saves all of it to the project file. Starting from the project file alone would turn every
 * skill the user turned off back on.
 */
async function writeList(
  input: RpcInput<typeof setOmpSkillEnabled>,
  dependencies: OmpSkillsDependencies,
  executable: string,
  runIn: string,
): Promise<void> {
  const projectPath = input.cwd ? join(input.cwd, ".omp", "config.yml") : null;
  const snapshot = projectPath
    ? await readProjectConfigText(projectPath).catch(() => {
        throw new OmpSkillsError(UNREADABLE_CONFIG);
      })
    : "";
  const current = await readList(dependencies, executable, input.list, runIn);
  const kept = current.filter((entry) => entry.trim() !== input.entry);
  const next = input.enabled ? kept : [...kept, input.entry];
  if (input.cwd) {
    const outcome = await writeProjectChanges(
      input.cwd,
      snapshot,
      [{ operation: "set", path: input.list, value: next }],
      executable,
      dependencies,
    ).catch((error: unknown) => {
      // The writer's messages are written for the user, as in the settings editor.
      throw new OmpSkillsError(
        error instanceof Error ? error.message : "Could not update workspace settings.",
      );
    });
    if (outcome === "conflict") {
      throw new OmpSkillsError("The workspace configuration changed. Try again");
    }
    return;
  }
  const run = await dependencies.run(
    executable,
    ["config", "set", input.list, "--json", "--", JSON.stringify(next)],
    runIn,
  );
  if (run.outcome !== "exited" || run.exitCode !== 0) {
    throw new OmpSkillsError("OMP rejected the change");
  }
}

export async function setOmpSkillEnabledWithDependencies(
  input: RpcInput<typeof setOmpSkillEnabled>,
  dependencies: OmpSkillsDependencies,
): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  try {
    if (input.list === "disabledExtensions" && !input.entry.startsWith(SKILL_ENTRY_PREFIX)) {
      throw new OmpSkillsError("That entry is not a skill");
    }
    const executable = await requireExecutable(dependencies);
    await inOmpScope(input.cwd, dependencies, (runIn) =>
      runSettingsMutation(() => writeList(input, dependencies, executable, runIn)),
    );
    return { status: "ok" };
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

/**
 * Deletes one agent-learned skill folder. The path must be a managed skill OMP lists right now
 * and a real directory directly inside `<agent dir>/managed-skills`, so a client can never name
 * anything else.
 */
export async function deleteOmpManagedSkillWithDependencies(
  input: RpcInput<typeof deleteOmpManagedSkill>,
  dependencies: OmpSkillsDependencies,
): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  try {
    const executable = await requireExecutable(dependencies);
    const skills = await inOmpScope(undefined, dependencies, (runIn) =>
      listSkills(dependencies, executable, runIn),
    );
    const skill = skills.find((candidate) => candidate.managed && candidate.path === input.path);
    if (!skill) throw new OmpSkillsError("That is not a skill the agent learned");
    const root = join(await realpath(ompAgentDir()), "managed-skills");
    const folder = await lstat(skill.path).catch(() => null);
    const inside =
      folder?.isDirectory() === true &&
      skill.path === resolve(skill.path) &&
      basename(skill.path) !== "" &&
      (await realpath(dirname(skill.path))) === root;
    if (!inside)
      throw new OmpSkillsError("That skill folder is not in OMP's managed skills folder");
    await dependencies.removeDir(skill.path);
    return { status: "ok" };
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

const DEFAULT_DEPENDENCIES: OmpSkillsDependencies = {
  ...ompCommandDependencies,
  validateProjectConfig: ompSettingsDependencies.validateProjectConfig,
};

export function resolveListOmpSkills(input: RpcInput<typeof listOmpSkills>) {
  return listOmpSkillsWithDependencies(input, DEFAULT_DEPENDENCIES);
}

export function resolveSetOmpSkillEnabled(input: RpcInput<typeof setOmpSkillEnabled>) {
  return setOmpSkillEnabledWithDependencies(input, DEFAULT_DEPENDENCIES);
}

export function resolveDeleteOmpManagedSkill(input: RpcInput<typeof deleteOmpManagedSkill>) {
  return deleteOmpManagedSkillWithDependencies(input, DEFAULT_DEPENDENCIES);
}
