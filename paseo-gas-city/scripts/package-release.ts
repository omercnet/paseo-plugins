import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";

const packageJson = JSON.parse(
  await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };

const releaseFiles = [
  "CHANGELOG.md",
  "icon.svg",
  "LICENSE",
  "README.md",
  "biome.json",
  "docs/images/paseo-gas-city-wide-overview.webp",
  "docs/images/paseo-gas-city-wide-events.webp",
  "docs/images/paseo-gas-city-dispatch-confirmation.webp",
  "docs/images/paseo-gas-city-compact-overview.webp",
  "index.client.tsx",
  "index.server.ts",
  "client/city-operations.tsx",
  "client/contribute.tsx",
  "client/dispatch-intent.ts",
  "client/factory-panel.tsx",
  "client/gas-city-surface.tsx",
  "client/settings-screen.tsx",
  "client/view-model.ts",
  "server/gas-city-client.ts",
  "server/handlers.ts",
  "server/workspace-mapping.ts",
  "shared/index.ts",
  "shared/limits.ts",
  "shared/rpc.ts",
  "shared/schemas.ts",
  "shared/settings.ts",
  "package.json",
  "paseo-plugin.json",
  "tsconfig.json",
  "tsconfig.client.json",
  "tsconfig.server.json",
] as const;

const output = process.argv[2] ?? `dist/paseo-gas-city-v${packageJson.version}.zip`;
const root = "paseo-gas-city";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[join(root, path)] = await readFile(path);
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
