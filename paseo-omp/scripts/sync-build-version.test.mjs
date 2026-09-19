import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { synchronizeBuildVersion } from "./sync-build-version.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture(version, declaration) {
  const root = await mkdtemp(join(tmpdir(), "paseo-omp-build-version-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "server"));
  await writeFile(join(root, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
  await writeFile(join(root, "server", "package-version.ts"), declaration);
  return root;
}

const stableDeclaration =
  "/** Release Please keeps this bundle-safe constant aligned with package.json. */\n" +
  'export const PASEO_OMP_PACKAGE_VERSION = "0.3.0"; // x-release-please-version\n';

test("atomically synchronizes the exact next version from package.json", async () => {
  const root = await fixture("0.3.0-next.123.2", stableDeclaration);

  await expect(synchronizeBuildVersion(root)).resolves.toBe("0.3.0-next.123.2");
  await expect(readFile(join(root, "server", "package-version.ts"), "utf8")).resolves.toBe(
    stableDeclaration.replace('"0.3.0"', '"0.3.0-next.123.2"'),
  );
  await expect(readdir(join(root, "server"))).resolves.toEqual(["package-version.ts"]);
});

test.each([
  "",
  "next",
  "1.2",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-01",
  "1.2.3-a..b",
  "1.2.3-a.",
  "1.2.3/unsafe",
  "1.2.3-next.$RUN_NUMBER",
])("rejects malformed package version %j", async (version) => {
  const root = await fixture(version, stableDeclaration);
  await expect(synchronizeBuildVersion(root)).rejects.toThrow("package version is invalid");
});

test("fails closed when the release marker is missing", async () => {
  const root = await fixture(
    "0.3.0-next.1.1",
    'export const PASEO_OMP_PACKAGE_VERSION = "0.3.0";\n',
  );
  await expect(synchronizeBuildVersion(root)).rejects.toThrow(
    "Expected exactly one x-release-please-version marker",
  );
});

test("fails closed when release markers are duplicated", async () => {
  const root = await fixture("0.3.0-next.1.1", `${stableDeclaration}// x-release-please-version\n`);
  await expect(synchronizeBuildVersion(root)).rejects.toThrow(
    "Expected exactly one x-release-please-version marker",
  );
});

test("fails closed when a marked declaration has an unmarked duplicate", async () => {
  const root = await fixture(
    "0.3.0-next.1.1",
    `${stableDeclaration}export const PASEO_OMP_PACKAGE_VERSION = "0.3.0";\n`,
  );
  await expect(synchronizeBuildVersion(root)).rejects.toThrow(
    "Expected exactly one PASEO_OMP_PACKAGE_VERSION declaration",
  );
});

test("fails closed when the sole marker is detached from the sole declaration", async () => {
  const root = await fixture(
    "0.3.0-next.1.1",
    'export const PASEO_OMP_PACKAGE_VERSION = "0.3.0";\n// x-release-please-version\n',
  );
  await expect(synchronizeBuildVersion(root)).rejects.toThrow(
    "Expected the sole package version declaration to contain the sole marker",
  );
});

test("fails closed when the marked declaration drifts", async () => {
  const root = await fixture(
    "0.3.0-next.1.1",
    'export const OTHER_VERSION = "0.3.0"; // x-release-please-version\n',
  );
  await expect(synchronizeBuildVersion(root)).rejects.toThrow(
    "Expected exactly one PASEO_OMP_PACKAGE_VERSION declaration",
  );
});
