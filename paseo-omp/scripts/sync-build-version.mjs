import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MAX_VERSION_LENGTH = 128;
const MARKER = "x-release-please-version";
const ANY_DECLARATION_PATTERN =
  /^\s*(?:export\s+)?(?:const|let|var)\s+PASEO_OMP_PACKAGE_VERSION\b[^\r\n]*$/gmu;
const MARKED_DECLARATION_PATTERN =
  /^export const PASEO_OMP_PACKAGE_VERSION = "([^"]+)"; \/\/ x-release-please-version$/mu;

export async function synchronizeBuildVersion(root = projectRoot) {
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest.version !== "string" ||
    manifest.version.length > MAX_VERSION_LENGTH ||
    !VERSION_PATTERN.test(manifest.version)
  ) {
    throw new Error("paseo-omp package version is invalid");
  }

  const targetPath = join(root, "server", "package-version.ts");
  const source = await readFile(targetPath, "utf8");
  const declarations = [...source.matchAll(ANY_DECLARATION_PATTERN)];
  if (declarations.length !== 1) {
    throw new Error("Expected exactly one PASEO_OMP_PACKAGE_VERSION declaration");
  }
  if (source.split(MARKER).length - 1 !== 1) {
    throw new Error("Expected exactly one x-release-please-version marker");
  }
  const markedDeclaration = declarations[0]?.[0].match(MARKED_DECLARATION_PATTERN);
  if (
    !markedDeclaration ||
    markedDeclaration[1].length > MAX_VERSION_LENGTH ||
    !VERSION_PATTERN.test(markedDeclaration[1])
  ) {
    throw new Error("Expected the sole package version declaration to contain the sole marker");
  }

  const updated = source.replace(
    MARKED_DECLARATION_PATTERN,
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
      mode: targetStat.mode & 0o777,
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
