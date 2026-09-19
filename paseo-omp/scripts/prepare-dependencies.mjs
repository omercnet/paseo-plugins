import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/u;

export function generateBuildVersion(root = projectRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !PACKAGE_VERSION.test(manifest.version)) {
    throw new Error("paseo-omp package version is invalid");
  }
  const outputDirectory = join(root, "server", "generated");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, "package-version.js"),
    `export const PASEO_OMP_BUILD_VERSION = ${JSON.stringify(manifest.version)};\n`,
  );
  return manifest.version;
}

export function prepareDependencies(root = projectRoot, execute = execFileSync) {
  generateBuildVersion(root);
  if (!existsSync(join(root, "package-lock.json"))) return false;

  execute(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--omit=dev", "--ignore-scripts"],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareDependencies();
}
