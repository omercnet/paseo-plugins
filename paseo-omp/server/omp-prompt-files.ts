import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { OmpPromptFiles } from "../shared/omp-prompt-files";
import { ompAgentDir } from "./paths";

async function hasNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hasPromptFile(directories: readonly string[], name: string): Promise<boolean> {
  const found = await Promise.all(
    directories.map((directory) => hasNonEmptyFile(join(directory, name))),
  );
  return found.some(Boolean);
}

/**
 * Paseo's host Append system prompt, as a yes/no. Null when the host refuses or fails the read:
 * the caller then words the warning as "may be replaced" instead of guessing.
 */
export async function readHostAppendPrompt(
  paseo: PluginHandlerContext["paseo"],
): Promise<boolean | null> {
  try {
    const { config } = await paseo.config.get();
    return config.appendSystemPrompt.trim() !== "";
  } catch {
    return null;
  }
}

/** Where OMP looks: the agent directory, plus the workspace's `.omp/` for a project view. */
export async function readOmpPromptFiles(
  cwd: string | undefined,
  hostAppendPrompt: boolean | null,
): Promise<OmpPromptFiles> {
  const directories = [ompAgentDir(), ...(cwd ? [join(cwd, ".omp")] : [])];
  const [appendSystemFile, systemFile] = await Promise.all([
    hasPromptFile(directories, "APPEND_SYSTEM.md"),
    hasPromptFile(directories, "SYSTEM.md"),
  ]);
  return { appendSystemFile, systemFile, hostAppendPrompt };
}
