import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { ENABLE_OMP } from "../server/daemon-config";

const run = promisify(execFile);

async function enable(config: unknown) {
  const home = await mkdtemp(join(tmpdir(), "sandbox-daemon-"));
  const path = join(home, "config.json");
  await writeFile(path, JSON.stringify(config));
  const [command, ...args] = ENABLE_OMP;
  await run(command, args, { env: { ...process.env, PASEO_HOME: home } });
  return JSON.parse(await readFile(path, "utf8"));
}

describe("enabling the OMP provider in the sandbox daemon", () => {
  test("turns it on and keeps every other setting, including other providers", async () => {
    const config = await enable({
      daemon: { listen: "127.0.0.1:6767" },
      agents: { providers: { claude: { enabled: false }, omp: { env: { A: "b" } } } },
    });

    expect(config).toEqual({
      daemon: { listen: "127.0.0.1:6767" },
      agents: {
        providers: { claude: { enabled: false }, omp: { env: { A: "b" }, enabled: true } },
      },
    });
  });

  test("works on a config with no agents section, and twice in a row", async () => {
    const once = await enable({ version: 1 });
    expect(once).toEqual({ version: 1, agents: { providers: { omp: { enabled: true } } } });
    expect(await enable(once)).toEqual(once);
  });
});
