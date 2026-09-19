import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,47})?$/u;
const MARKER = "x-release-please-version";
const DECLARATION_PATTERN =
  /^export const PASEO_OMP_PACKAGE_VERSION = "([^"]+)"; \/\/ x-release-please-version$/gmu;

export async function synchronizeBuildVersion(root = projectRoot) {
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)) {
    throw new Error("paseo-omp package version is invalid");
  }

  const targetPath = join(root, "server", "package-version.ts");
  const source = await readFile(targetPath, "utf8");
  if (source.split(MARKER).length - 1 !== 1) {
    throw new Error("Expected exactly one x-release-please-version marker");
  }
  const declarations = [...source.matchAll(DECLARATION_PATTERN)];
  if (declarations.length !== 1 || !VERSION_PATTERN.test(declarations[0]?.[1] ?? "")) {
    throw new Error("Expected exactly one valid paseo-omp package version declaration");
  }

  const updated = source.replace(
    DECLARATION_PATTERN,
    `export const PASEO_OMP_PACKAGE_VERSION = ${JSON.stringify(manifest.version)}; // ${MARKER}`,
  );
  const targetStat = await stat(targetPath);
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, updated, {
      encoding: "utf8",
      flag: "wx",
      mode: targetStat.mode,
    });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return manifest.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await synchronizeBuildVersion();
}
