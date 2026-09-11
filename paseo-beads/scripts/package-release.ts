import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import packageJson from "../package.json";

const releaseFiles = [
  "bun.lock",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "biome.json",
  "bunfig.toml",
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

const output = Bun.argv[2] ?? `dist/paseo-beads-v${packageJson.version}.zip`;
const root = "paseo-beads";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[join(root, path)] = await Bun.file(path).bytes();
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await Bun.write(output, zipSync(files, { level: 9 }));
console.log(output);
