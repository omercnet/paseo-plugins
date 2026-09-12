import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";

const packageJson = JSON.parse(
  await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };

const releaseFiles = [
  "LICENSE",
  "README.md",
  "index.client.tsx",
  "index.server.ts",
  "client/pr-radar.tsx",
  "client/radar.ts",
  "server/viewer-scope.ts",
  "shared/viewer-scope.ts",
  "docs/images/pr-radar-github-inbox-wide.png",
  "docs/images/pr-radar-github-inbox-compact.png",
  "package.json",
  "paseo-plugin.json",
  "tsconfig.json",
] as const;

const output = process.argv[2] ?? `dist/pr-radar-v${packageJson.version}.zip`;
const root = "pr-radar";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[join(root, path)] = await readFile(path);
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
