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
