import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function resolveDependencyRoot(packageName, from = import.meta.url) {
  const require = createRequire(from);
  return dirname(require.resolve(`${packageName}/package.json`));
}
export function prepareDependencies(root = projectRoot, execute = execFileSync) {
  if (!existsSync(join(root, "package-lock.json"))) return false;

  execute(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--include=dev"], {
    cwd: root,
    stdio: "inherit",
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareDependencies();
}
