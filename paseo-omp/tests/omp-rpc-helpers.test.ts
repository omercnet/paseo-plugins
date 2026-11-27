import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OmpRpcProcess } from "../server/omp-accounts";
import { buildStatefulCommandEnv } from "../server/provider-diagnostics";

interface Launch {
  args: readonly string[];
  credential?: string;
}

beforeEach(() => {
  for (const name of [
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CODING_AGENT_DIR",
    "PASEO_OMP_AGENT_DIR",
    "OMP_AGENT_DIR",
    "PI_CONFIG_DIR",
  ]) {
    vi.stubEnv(name, undefined);
  }
});
const directories: string[] = [];

function redactionProbe(): [stderr: string, privateFields: string[]] {
  const credential = randomUUID();
  const account = `${randomUUID()}@synthetic invalid`;
  const callback = `https://${randomUUID()}.invalid/callback?code=${randomUUID()}`;
  return [
    `credential=${credential} account=${account} callback=${callback}`,
    [credential, account, callback],
  ];
}

async function errorFromOutput(prefix: string, providers: string[] = []): Promise<Error> {
  const [stderr, privateFields] = redactionProbe();
  expect(privateFields).toHaveLength(3);
  const fixture = await fakeOmp(false, providers, prefix + stderr + "_END_".repeat(2000));
  const helper = new OmpRpcProcess(fixture);
  const error = await helper
    .request({ type: "get_login_providers" })
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  for (const field of privateFields) expect((error as Error).message).not.toContain(field);
  helper.close();
  return error as Error;
}

async function fakeOmp(
  noDefault: boolean,
  disabledProviders: string[] = [],
  stderr: string | null = null,
) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-omp-rpc-start-"));
  directories.push(directory);
  await mkdir(join(directory, ".omp", "agent"), { recursive: true });
  await writeFile(
    join(directory, ".omp", "agent", "config.yml"),
    JSON.stringify({ disabledProviders, modelRoles: { default: "local/default" } }),
  );
  const executable = join(directory, "omp");
  const log = join(directory, "calls.jsonl");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, credential: process.env.OPENAI_API_KEY }) + "\\n");
const model = args[args.indexOf("--model") + 1];
if (${JSON.stringify(stderr !== null)}) {
  process.stderr.write(${JSON.stringify(stderr ?? "")});
  process.exit(1);
}
if (${JSON.stringify(noDefault)} && !args.includes("--model")) {
  process.stderr.write("No default model selected.");
  process.exit(1);
}
const print = value => process.stdout.write(JSON.stringify(value) + "\\n");
print({ type: "ready" });
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  print({ type: "response", id: request.id, success: true, data: {} });
});
`,
  );
  await chmod(executable, 0o755);
  return {
    executable,
    log,
    env: buildStatefulCommandEnv({
      PATH: process.env.PATH ?? "",
      HOME: directory,
      PI_CODING_AGENT_DIR: join(directory, ".omp", "agent"),
      OPENAI_API_KEY: "must-not-reach-helper",
    }),
  };
}

async function recorded(log: string): Promise<Launch[]> {
  return (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line): Launch => JSON.parse(line));
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("OmpRpcProcess startup models", () => {
  test("uses the configured default with disabled built-ins and no leaked keys", async () => {
    const fixture = await fakeOmp(false, ["anthropic"]);
    const helper = new OmpRpcProcess(fixture);
    expect(await helper.request({ type: "get_login_providers" })).toEqual({});
    helper.close();
    for (const launch of await recorded(fixture.log)) {
      expect(launch.args).not.toContain("--model");
      expect(launch.credential).toBeUndefined();
    }
  });

  test("retries only missing model selection and skips disabled providers", async () => {
    const fixture = await fakeOmp(true, ["anthropic"]);
    const helper = new OmpRpcProcess(fixture);
    expect(await helper.request({ type: "get_login_providers" })).toEqual({});
    helper.close();
    const launches = await recorded(fixture.log);
    expect(launches).toHaveLength(2);
    expect(launches[0]?.args).not.toContain("--model");
    expect(launches[1]?.args.slice(-2)).toEqual(["--model", "openai/gpt-4.1"]);
    for (const launch of launches) expect(launch.credential).toBeUndefined();
  });

  test("unrecognized failures expose neither stderr nor its contents", async () => {
    const error = await errorFromOutput("unrecognized startup failure\n");
    expect(error.message).toBe("omp exited with code 1");
  });

  test("only fixed model startup guidance crosses the helper boundary", async () => {
    const error = await errorFromOutput("No default model selected.\n", [
      "anthropic",
      "openai",
      "google",
    ]);
    expect(error.message).toBe(
      "omp exited with code 1: OMP needs a default model for slash-command helpers. Configure one with OMP's /model command.",
    );
  });
});
