import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
const runtimeRoot = join(paseoHome, "plugin-data", "shared-browser", "runtime");
const runtimeModules = join(runtimeRoot, "node_modules");
const packages = ["playwright", "playwright-core"];

await mkdir(runtimeModules, { recursive: true, mode: 0o700 });
await chmod(join(paseoHome, "plugin-data", "shared-browser"), 0o700);
await chmod(runtimeRoot, 0o700);
await chmod(runtimeModules, 0o700);
await writeFile(
  join(runtimeRoot, "package.json"),
  `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
  { mode: 0o600 },
);

for (const packageName of packages) {
  const source = join(projectRoot, "node_modules", packageName);
  const destination = join(runtimeModules, packageName);
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, force: true });
}

console.log(`Prepared Shared Browser runtime dependencies in ${runtimeRoot}`);
