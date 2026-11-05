import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { OmpPromptFiles } from "../shared/omp-prompt-files";
import { ompAgentDir } from "./paths";

// OMP checks for the file's existence, so an empty file still counts. A `.omp` that is a file
// (ENOTDIR) simply has no prompt files in it.
async function hasFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function hasPromptFile(directories: readonly string[], name: string): Promise<boolean> {
  const found = await Promise.all(directories.map((directory) => hasFile(join(directory, name))));
  return found.some(Boolean);
}

/** Paseo's host Append system prompt as a yes/no; the text never leaves this function. */
export async function readHostAppendPrompt(paseo: PluginHandlerContext["paseo"]): Promise<boolean> {
  const { config } = await paseo.config.get();
  return config.appendSystemPrompt.trim() !== "";
}

/** Where OMP looks: the agent directory, plus the workspace's `.omp/` for a project view. */
export async function readOmpPromptFiles(
  cwd: string | undefined,
  hostAppendPrompt: boolean,
): Promise<OmpPromptFiles> {
  const directories = [ompAgentDir(), ...(cwd ? [join(cwd, ".omp")] : [])];
  const [appendSystemFile, systemFile] = await Promise.all([
    hasPromptFile(directories, "APPEND_SYSTEM.md"),
    hasPromptFile(directories, "SYSTEM.md"),
  ]);
  return { appendSystemFile, systemFile, hostAppendPrompt };
}
