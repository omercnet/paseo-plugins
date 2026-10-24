import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dockerProvider } from "../server/docker";
import { IMAGE_TAG } from "../server/docker-image";

/** A stand-in `docker` that logs every call and answers from a JSON scenario file. */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER + ".json", "utf8"));
const args = process.argv.slice(2);
const names = args.filter((a, i) => args[i - 1] === "--env");
fs.appendFileSync(process.env.FAKE_DOCKER + ".log", JSON.stringify({ args, env: Object.fromEntries(names.map((n) => [n, process.env[n]])) }) + "\\n");
const key = args.slice(0, 2).join(" ");
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
if (key === "image inspect") scenario.image ? process.exit(0) : fail("Error: No such image");
if (key === "container inspect") {
  if (!scenario.container) fail("Error: No such container");
  const { state, image, revision, health } = scenario.container;
  process.stdout.write(args.includes("{{.State.Status}} {{.State.Health.Status}}") ? state + " " + health : [state, image, revision].join("|"));
  process.exit(0);
}
if (key === "volume inspect") scenario.volume ? process.exit(0) : fail("Error: No such volume: " + args[2]);
if (key === "container start") { scenario.container.state = "running"; fs.writeFileSync(process.env.FAKE_DOCKER + ".json", JSON.stringify(scenario)); process.exit(0); }
if (key === "version --format" && scenario.unreachable) fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
if (key === "container stop" || key === "container rm" || key === "volume rm") scenario.missing ? fail("Error: No such container") : process.exit(0);
`;

let dir: string;
const calls = async () =>
  (await readFile(join(dir, "fake.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
const scenario = (value: object) => writeFile(join(dir, "fake.json"), JSON.stringify(value));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbox-docker-"));
  await writeFile(join(dir, "docker"), FAKE);
  await chmod(join(dir, "docker"), 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  vi.stubEnv("FAKE_DOCKER", join(dir, "fake"));
});
afterEach(() => vi.unstubAllEnvs());

const spec = {
  key: "abc",
  revision: "r1",
  env: { PASEO_PASSWORD: "pw-secret", GITHUB_TOKEN: "gh-secret" },
};

describe("dockerProvider.up", () => {
  test("creates an isolated sandbox and keeps secret values out of argv", async () => {
    // The fake never reports the container afterwards, so `up` fails after `run`; that is enough
    // to inspect how the sandbox was created.
    await scenario({ image: true });
    await expect(dockerProvider.up(spec, () => undefined)).rejects.toThrow();
    const [create] = (await calls()).filter((c) => c.args[0] === "run");
    expect(create).toBeDefined();
    const argv = create?.args.join(" ") ?? "";
    expect(argv).not.toContain("pw-secret");
    expect(argv).not.toContain("gh-secret");
    expect(create?.env).toEqual({ PASEO_PASSWORD: "pw-secret", GITHUB_TOKEN: "gh-secret" });
    expect(argv).toContain("--security-opt no-new-privileges");
    expect(argv).toContain("--cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID");
    expect(argv).toContain("paseo-sandbox-abc-home:/home/paseo");
    expect(argv).not.toMatch(/--publish|-p |--privileged|docker\.sock|--network host/);
    expect(argv.endsWith(IMAGE_TAG)).toBe(true);
  });

  test("a sandbox that never became healthy is removed with its data", async () => {
    await scenario({ image: true });
    await expect(dockerProvider.up(spec, () => undefined)).rejects.toThrow();
    const log = (await calls()).map((c) => c.args.slice(0, 3).join(" "));
    expect(log).toContain("container rm --force");
    expect(log).toContain("volume rm --force");
  });

  test("a failed start never deletes a volume that already held data", async () => {
    await scenario({ image: true, volume: true });
    await expect(dockerProvider.up(spec, () => undefined)).rejects.toThrow();
    const log = (await calls()).map((c) => c.args.slice(0, 3).join(" "));
    expect(log).toContain("container rm --force");
    expect(log).not.toContain("volume rm --force");
  });

  test("an existing sandbox with the same revision is started, never recreated", async () => {
    await scenario({
      image: true,
      container: { state: "exited", image: IMAGE_TAG, revision: "r1", health: "healthy" },
    });
    expect(await dockerProvider.up(spec, () => undefined)).toBe("paseo-sandbox-abc");
    const log = (await calls()).map((c) => c.args.slice(0, 2).join(" "));
    expect(log).toContain("container start");
    expect(log).not.toContain("container rm");
    expect(log).not.toContain("run --detach");
  });

  test("new credentials recreate the container but keep the volume", async () => {
    await scenario({
      image: true,
      container: { state: "running", image: IMAGE_TAG, revision: "old", health: "healthy" },
    });
    await dockerProvider.up(spec, () => undefined).catch(() => undefined);
    const log = (await calls()).map((c) => c.args.slice(0, 3).join(" "));
    expect(log).toContain("container rm --force");
    expect(log).not.toContain("volume rm --force");
    expect(log.some((entry) => entry.startsWith("run --detach"))).toBe(true);
  });

  test("builds the image from stdin only when it is missing", async () => {
    await scenario({
      image: false,
      container: { state: "running", image: IMAGE_TAG, revision: "r1", health: "healthy" },
    });
    const seen: string[] = [];
    await dockerProvider.up(spec, (phase) => seen.push(phase));
    expect((await calls()).some((c) => c.args[0] === "build" && c.args.at(-1) === "-")).toBe(true);
    expect(seen[0]).toContain("Building the runtime image");
  });
});

describe("dockerProvider.exec", () => {
  test("runs as the sandbox user and hands stdin to the command, not argv", async () => {
    await scenario({});
    await dockerProvider.exec("paseo-sandbox-abc", ["codex", "login"], { stdin: "secret\n" });
    const [call] = await calls();
    expect(call?.args).toEqual([
      "exec",
      "--interactive",
      "--user",
      "paseo",
      "paseo-sandbox-abc",
      "codex",
      "login",
    ]);
  });
});

describe("dockerProvider cleanup and availability", () => {
  test("stop and destroy tolerate a sandbox that is already gone", async () => {
    await scenario({ missing: true });
    await expect(dockerProvider.stop("paseo-sandbox-abc")).resolves.toBeUndefined();
    await expect(dockerProvider.destroy({ key: "abc", handle: null })).resolves.toBeUndefined();
  });

  test("an unreachable Docker daemon is explained, not surfaced as a raw error", async () => {
    await scenario({ unreachable: true });
    expect(await dockerProvider.unavailable()).toContain("Start Docker");
  });

  test("a missing docker binary is explained", async () => {
    vi.stubEnv("PATH", "/nonexistent");
    expect(await dockerProvider.unavailable()).toContain("not installed");
  });
});
