import { resolve } from "node:path";

const pluginRoot = resolve(import.meta.dirname, "..");
const coreRoot = process.env.PASEO_CORE_ROOT?.trim();
if (!coreRoot) {
  throw new Error("PASEO_CORE_ROOT must point to the matching Paseo core cutover checkout");
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

await run(["npm", "run", "build:server"], coreRoot);
await run(
  [
    process.execPath,
    "test",
    "tests/core-cutover.integration.test.ts",
    "tests/provider-conformance.test.ts",
  ],
  pluginRoot,
);
