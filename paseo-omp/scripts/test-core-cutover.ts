import { resolve } from "node:path";

const pluginRoot = resolve(import.meta.dirname, "..");
const legacyCoreRoot = process.env.PASEO_LEGACY_CORE_ROOT?.trim();
const cutoverCoreRoot = process.env.PASEO_CUTOVER_CORE_ROOT?.trim();
if (!legacyCoreRoot || !cutoverCoreRoot) {
  throw new Error(
    "PASEO_LEGACY_CORE_ROOT and PASEO_CUTOVER_CORE_ROOT must point to distinct Paseo checkouts",
  );
}
if (resolve(legacyCoreRoot) === resolve(cutoverCoreRoot)) {
  throw new Error("Legacy and cutover core roots must be distinct checkouts");
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode})`);
}

await run(["npm", "run", "build:server"], legacyCoreRoot);
await run(["npm", "run", "build:server"], cutoverCoreRoot);
await run(
  [
    process.execPath,
    "test",
    "tests/core-cutover.integration.test.ts",
    "tests/provider-conformance.test.ts",
  ],
  pluginRoot,
);
