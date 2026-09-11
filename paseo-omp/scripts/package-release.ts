import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import packageJson from "../package.json";

const releaseFiles = [
  "bun.lock",
  "LICENSE",
  "index.client.tsx",
  "index.server.ts",
  "client/hub-popover.tsx",
  "client/hub-icon.tsx",
  "client/hub-status.ts",
  "client/memory-panel.tsx",
  "client/memory-popover.tsx",
  "client/omp-config-surface.tsx",
  "client/sessions-popover.tsx",
  "client/quota-popover.tsx",
  "client/provider-icon.tsx",
  "client/provider-diagnostics-state.ts",
  "client/quota-state.ts",
  "server/hub.ts",
  "server/memory.ts",
  "server/omp-config.ts",
  "server/quota.ts",
  "server/sessions.ts",
  "server/paths.ts",
  "server/provider-diagnostics.ts",
  "server/provider/catalog.ts",
  "server/provider/connection.ts",
  "server/provider/omp-rpc.ts",
  "server/provider/omp.svg",
  "server/provider/registration.ts",
  "server/provider/session.ts",
  "server/provider/security.ts",
  "server/provider/session-descriptors.ts",
  "server/provider/timeline-projector.ts",
  "shared/hub.ts",
  "shared/memory.ts",
  "shared/omp-config.ts",
  "shared/quota.ts",
  "shared/sessions.ts",
  "shared/provider-diagnostics.ts",
  "package.json",
  "paseo-plugin.json",
  "tsconfig.json",
] as const;

const output = Bun.argv[2] ?? `dist/paseo-omp-v${packageJson.version}.zip`;
const root = "paseo-omp";
const files: Record<string, Uint8Array> = {};
for (const path of releaseFiles) files[join(root, path)] = await Bun.file(path).bytes();

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await Bun.write(output, zipSync(files, { level: 9 }));
console.log(output);
