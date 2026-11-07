import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AnalyticsWarning } from "../shared/analytics";

const MAX_PROJECTS = 256;
const MAX_DISCOVERY_WARNINGS = 10;

export interface ContextModeProjectDatabase {
  /** Project key directory name, `sha256(projectPath).slice(0, 16)` upstream. */
  project: string;
  path: string;
}

export interface StorageDiscoveryResult {
  databases: ContextModeProjectDatabase[];
  warnings: AnalyticsWarning[];
}

/** Context Mode 2.x data dir: absolute `CONTEXT_MODE_DATA_DIR`, else `~/.context-mode`. */
export function resolveContextModeDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.CONTEXT_MODE_DATA_DIR?.trim();
  return configured && isAbsolute(configured) ? resolve(configured) : join(home, ".context-mode");
}

/** Lists `<dataDir>/projects/<key>/context.db`, skipping project directories without a database. */
export async function discoverContextModeDatabases(
  dataDir: string,
): Promise<StorageDiscoveryResult> {
  const projectsDir = join(dataDir, "projects");
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { databases: [], warnings: [] };
    return {
      databases: [],
      warnings: [
        {
          code: "storage-unavailable",
          message: "The Context Mode projects directory could not be read.",
        },
      ],
    };
  }

  const projects = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const databases: ContextModeProjectDatabase[] = [];
  const warnings: AnalyticsWarning[] = [];

  for (const project of projects.slice(0, MAX_PROJECTS)) {
    const path = join(projectsDir, project, "context.db");
    try {
      const info = await lstat(path);
      if (info.isFile()) databases.push({ project, path });
      else if (warnings.length < MAX_DISCOVERY_WARNINGS) {
        warnings.push({
          code: "not-regular-database",
          project,
          message: "Skipped a context.db entry that is not a regular file.",
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (warnings.length < MAX_DISCOVERY_WARNINGS) {
        warnings.push({
          code: "storage-unavailable",
          project,
          message: "The project database could not be inspected.",
        });
      }
    }
  }

  if (projects.length > MAX_PROJECTS) {
    warnings.push({
      code: "result-truncated",
      message: `Only the first ${MAX_PROJECTS} of ${projects.length} Context Mode projects were inspected.`,
    });
  }

  return { databases, warnings };
}
