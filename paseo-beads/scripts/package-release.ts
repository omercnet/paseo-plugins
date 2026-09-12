import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";

const packageJson = JSON.parse(
  await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };

const releaseFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "biome.json",
  "docs/images/paseo-beads-wide.png",
  "docs/images/paseo-beads-compact.png",
  "index.client.tsx",
  "index.server.ts",
  "client/beads-view.ts",
  "client/paseo-beads.tsx",
  "client/web.ts",
  "server/beads.ts",
  "shared/beads.ts",
  "package.json",
  "paseo-plugin.json",
  "tsconfig.json",
] as const;

const output = process.argv[2] ?? `dist/paseo-beads-v${packageJson.version}.zip`;
const root = "paseo-beads";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[join(root, path)] = await readFile(path);
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
