import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shared-browser-prepare-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("removes the staging runtime when preparation fails", async () => {
  const script = fileURLToPath(new URL("../scripts/prepare-runtime.mjs", import.meta.url).href);

  await expect(
    execFileAsync(process.execPath, [script], {
      env: {
        ...process.env,
        PASEO_HOME: root,
        PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY: join(root, "missing-agent-browser"),
      },
    }),
  ).rejects.toThrow(/PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY/);

  expect(await readdir(join(root, "plugin-data", "shared-browser"))).toEqual([]);
});

it.each(["EBUSY", "EPERM"])(
  "keeps the preparation error when removing the stage fails with %s",
  async (code) => {
    const script = new URL("../scripts/replace-runtime.mjs", import.meta.url).href;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { discardRuntime } from ${JSON.stringify(script)};
const code = process.argv[1];
const removals = [];
async function remove(path, options) {
  removals.push(options);
  throw Object.assign(new Error(code + ": resource busy or locked"), { code });
}
try {
  await discardRuntime("stage", new Error("PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY is missing"), remove);
} catch (error) {
  process.stdout.write(JSON.stringify({ message: error.message, removals }));
}`,
        code,
      ],
      { encoding: "utf8" },
    );

    expect(JSON.parse(stdout)).toEqual({
      message: "PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY is missing",
      removals: [{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }],
    });
    expect(stderr).toContain(`${code}: resource busy or locked`);
  },
);
