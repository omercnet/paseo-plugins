import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";

const packageJson = JSON.parse(
  await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };

const releaseFiles = [
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "index.client.tsx",
  "index.server.ts",
  "client/agent-monitor.tsx",
  "client/diff-stat.tsx",
  "client/monitor.ts",
  "client/settings-screen.tsx",
  "client/settings-state.ts",
  "shared/monitor-settings.ts",
  "docs/images/agent-monitor-roster.png",
  "docs/images/agent-monitor-settings.png",
  "package.json",
  "paseo-plugin.json",
  "tsconfig.json",
] as const;

const output = process.argv[2] ?? `dist/agent-monitor-v${packageJson.version}.zip`;
const root = "agent-monitor";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[join(root, path)] = await readFile(path);
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
