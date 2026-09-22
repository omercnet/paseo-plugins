import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { zipSync } from "fflate";
import { resolveCatalogPackageJson } from "../../scripts/resolve-catalog-package.mjs";

const packageJson = JSON.parse(
  await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };
const resolvedPackageJson = await resolveCatalogPackageJson(
  packageJson,
  join(import.meta.dirname, "..", ".."),
);

const releaseFiles = [
  "LICENSE",
  "README.md",
  "index.client.ts",
  "package.json",
  "paseo-plugin.json",
] as const;

const output = process.argv[2] ?? `dist/paseo-dracula-v${packageJson.version}.zip`;
const root = "paseo-dracula";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[posix.join(root, path)] = path === "package.json"
    ? new TextEncoder().encode(JSON.stringify(resolvedPackageJson, null, 2) + "\n")
    : await readFile(path);
}
await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
