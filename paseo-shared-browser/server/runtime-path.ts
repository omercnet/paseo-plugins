import { readFileSync } from "node:fs";
import { join } from "node:path";

export function resolveBrowserRuntimeRoot(paseoHome: string): string {
  const pluginDataRoot = join(paseoHome, "plugin-data", "shared-browser");
  let directory: string;
  try {
    directory = readFileSync(join(pluginDataRoot, "runtime-current"), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(pluginDataRoot, "runtime");
    throw error;
  }
  if (
    !/^\.runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      directory,
    )
  ) {
    throw new Error("Shared Browser runtime pointer is invalid");
  }
  return join(pluginDataRoot, directory);
}
