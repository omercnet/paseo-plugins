import { join } from "node:path";
import { z } from "zod";
import { type OmpRulesDependencies, ompCommandDependencies, readSetting } from "./omp-rules";
import {
  type OmpSettingsDependencies,
  ompSettingsDependencies,
  readProjectConfigText,
  writeProjectChanges,
} from "./omp-settings";
import { OmpPublicError } from "./provider/security";

export type OmpListName = "skills.ignoredSkills" | "disabledExtensions";

export class OmpListError extends OmpPublicError {}

export interface OmpListDependencies extends OmpRulesDependencies {
  validateProjectConfig: OmpSettingsDependencies["validateProjectConfig"];
}

export const ompListDependencies: OmpListDependencies = {
  ...ompCommandDependencies,
  validateProjectConfig: ompSettingsDependencies.validateProjectConfig,
};

const ListSettingSchema = z.object({ value: z.array(z.string()) });
const UNREADABLE_CONFIG = "The workspace OMP configuration could not be read";

export async function requireOmpExecutable(dependencies: OmpListDependencies): Promise<string> {
  const executable = await dependencies.resolveExecutable();
  if (!executable) throw new OmpListError("The omp command was not found on this host");
  return executable;
}

/** The effective list in `runIn`: a workspace's own list when it has one, else the user's. */
export function readList(
  dependencies: OmpListDependencies,
  executable: string,
  list: OmpListName,
  runIn: string,
): Promise<string[]> {
  return readSetting(dependencies, executable, list, ListSettingSchema, runIn);
}

export interface ListEntryChange {
  cwd?: string;
  list: OmpListName;
  entry: string;
  /** Enabled removes the entry from the list; disabled adds it. */
  enabled: boolean;
}

/**
 * A project list replaces the user list, so a workspace edit starts from the effective list and
 * saves all of it to the project file. Starting from the project file alone would turn every
 * entry the user turned off back on. Run it inside `runSettingsMutation`.
 */
export async function writeListEntry(
  change: ListEntryChange,
  dependencies: OmpListDependencies,
  executable: string,
  runIn: string,
): Promise<void> {
  const projectPath = change.cwd ? join(change.cwd, ".omp", "config.yml") : null;
  const snapshot = projectPath
    ? await readProjectConfigText(projectPath).catch(() => {
        throw new OmpListError(UNREADABLE_CONFIG);
      })
    : "";
  const current = await readList(dependencies, executable, change.list, runIn);
  const kept = current.filter((entry) => entry.trim() !== change.entry);
  const next = change.enabled ? kept : [...kept, change.entry];
  if (change.cwd) {
    const outcome = await writeProjectChanges(
      change.cwd,
      snapshot,
      [{ operation: "set", path: change.list, value: next }],
      executable,
      dependencies,
    ).catch((error: unknown) => {
      // The writer's messages are written for the user, as in the settings editor.
      throw new OmpListError(
        error instanceof Error ? error.message : "Could not update workspace settings.",
      );
    });
    if (outcome === "conflict") {
      throw new OmpListError("The workspace configuration changed. Try again");
    }
    return;
  }
  const run = await dependencies.run(
    executable,
    ["config", "set", change.list, "--json", "--", JSON.stringify(next)],
    runIn,
  );
  if (run.outcome !== "exited" || run.exitCode !== 0) {
    throw new OmpListError("OMP rejected the change");
  }
}
