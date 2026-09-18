import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function prepareDependencies(root = projectRoot, execute = execFileSync) {
  if (!existsSync(join(root, "package-lock.json"))) return false;

  execute(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"], {
    cwd: root,
    stdio: "inherit",
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareDependencies();
}
