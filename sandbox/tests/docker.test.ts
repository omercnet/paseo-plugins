import { beforeEach, describe, expect, test } from "vitest";
import { type DockerCli, DockerError, type DockerOptions } from "../server/docker/cli";
import { IMAGE_TAG } from "../server/docker/image";
import { createDockerProvider } from "../server/docker/provider";

interface FakeContainer {
  state: "running" | "exited";
  image: string;
  revision: string;
  health: "healthy" | "unhealthy";
}

interface Call {
  args: readonly string[];
  options: DockerOptions;
}

/** An in-memory Docker: containers, volumes and images, with the answers the CLI would give. */
class FakeDocker {
  images = new Set<string>();
  volumes = new Set<string>();
  containers = new Map<string, FakeContainer>();
  calls: Call[] = [];
  daemonDown = false;
  health: FakeContainer["health"] = "healthy";

  readonly cli: DockerCli = async (args, options = {}) => {
    this.calls.push({ args, options });
    const [group, verb] = args;
    const name = args.at(-1) ?? "";
    if (this.daemonDown)
      throw new DockerError("docker version failed", "Cannot connect to the Docker daemon");
    if (group === "version") return ok("27");
    if (group === "image" && verb === "inspect")
      return this.require(this.images.has(name), "image");
    if (group === "build") {
      this.images.add(IMAGE_TAG);
      return ok("");
    }
    if (group === "volume" && verb === "inspect")
      return this.require(this.volumes.has(name), "volume");
    if (group === "volume" && verb === "create") {
      this.volumes.add(name);
      return ok(name);
    }
    if (group === "volume" && verb === "rm") {
      if (!this.volumes.delete(name)) throw missing("volume", name);
      return ok("");
    }
    if (group === "exec") return ok("");
    if (group === "run") return this.run(args, options);
    if (group === "container") return this.container(verb ?? "", args, name);
    throw new Error(`Unhandled docker call: ${args.join(" ")}`);
  };

  private require(present: boolean, kind: string) {
    if (!present) throw missing(kind, "x");
    return ok("");
  }

  private run(args: readonly string[], options: DockerOptions) {
    const name = args[args.indexOf("--name") + 1] ?? "";
    const label = args.find((arg) => arg.includes("sandbox.revision=")) ?? "";
    this.containers.set(name, {
      state: "running",
      image: args.at(-1) ?? "",
      revision: label.split("=")[1] ?? "",
      health: this.health,
    });
    return ok(options.env ? name : "");
  }

  private container(verb: string, args: readonly string[], name: string) {
    const found = this.containers.get(name);
    if (verb === "rm") {
      if (!this.containers.delete(name)) throw missing("container", name);
      return ok("");
    }
    if (!found) throw missing("container", name);
    if (verb === "start") found.state = "running";
    if (verb === "stop") found.state = "exited";
    if (verb === "inspect") {
      const format = args[args.indexOf("--format") + 1] ?? "";
      const text = format.includes("Health")
        ? `${found.state} ${found.health}`
        : [found.state, found.image, found.revision].join("|");
      return ok(text);
    }
    return ok("");
  }

  verbs(prefix = 2) {
    return this.calls.map((call) => call.args.slice(0, prefix).join(" "));
  }
}

function ok(stdout: string) {
  return { stdout, stderr: "" };
}

function missing(kind: string, name: string) {
  return new DockerError(`docker failed`, `Error: No such ${kind}: ${name}`);
}

const spec = {
  key: "abc",
  revision: "r1",
  env: { PASEO_PASSWORD: "pw-secret", GITHUB_TOKEN: "gh-secret" },
};
const phases = () => undefined;

let docker: FakeDocker;
beforeEach(() => {
  docker = new FakeDocker();
  docker.images.add(IMAGE_TAG);
});

describe("up", () => {
  test("creates an isolated sandbox and keeps secret values out of argv", async () => {
    const handle = await createDockerProvider(docker.cli).up(spec, phases);

    const run = docker.calls.find((call) => call.args[0] === "run");
    const argv = run?.args.join(" ") ?? "";
    expect(handle).toBe("paseo-sandbox-abc");
    expect(argv).not.toContain("pw-secret");
    expect(argv).not.toContain("gh-secret");
    expect(run?.options.env).toEqual(spec.env);
    expect(argv).toContain("--security-opt no-new-privileges");
    expect(argv).toContain("--cap-drop ALL");
    expect(argv).toContain("paseo-sandbox-abc-home:/home/paseo");
    expect(argv).not.toMatch(/--publish|-p |--privileged|docker\.sock|--network host/);
    expect(argv.endsWith(IMAGE_TAG)).toBe(true);
  });

  test("builds the image from stdin only when it is missing", async () => {
    docker.images.clear();
    const seen: string[] = [];
    await createDockerProvider(docker.cli).up(spec, (phase) => seen.push(phase));
    const build = docker.calls.find((call) => call.args[0] === "build");
    expect(build?.args.at(-1)).toBe("-");
    expect(build?.options.stdin).toContain("FROM ghcr.io/getpaseo/paseo");
    expect(seen[0]).toContain("Building the runtime image");
  });

  test("an existing sandbox with the same revision is started, never recreated", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up(spec, phases);
    await provider.stop("paseo-sandbox-abc");
    docker.calls = [];

    await provider.up(spec, phases);

    expect(docker.verbs()).toContain("container start");
    expect(docker.verbs()).not.toContain("container rm");
    expect(docker.verbs(1)).not.toContain("run");
  });

  test("new credentials recreate the container but keep the volume", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up(spec, phases);
    docker.calls = [];

    await provider.up({ ...spec, revision: "r2" }, phases);

    expect(docker.verbs()).toContain("container rm");
    expect(docker.verbs()).not.toContain("volume rm");
    expect(docker.containers.get("paseo-sandbox-abc")?.revision).toBe("r2");
    expect(docker.volumes.has("paseo-sandbox-abc-home")).toBe(true);
  });

  test("a sandbox that never became healthy is removed with its data", async () => {
    docker.health = "unhealthy";
    await expect(createDockerProvider(docker.cli).up(spec, phases)).rejects.toThrow("unhealthy");
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  test("a failed start never deletes a volume that already held data", async () => {
    docker.volumes.add("paseo-sandbox-abc-home");
    docker.health = "unhealthy";
    await expect(createDockerProvider(docker.cli).up(spec, phases)).rejects.toThrow();
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.has("paseo-sandbox-abc-home")).toBe(true);
  });
});

describe("exec", () => {
  test("runs as the sandbox user and hands stdin to the command, not argv", async () => {
    await createDockerProvider(docker.cli).exec({
      handle: "paseo-sandbox-abc",
      argv: ["codex", "login"],
      stdin: "secret\n",
    });
    const [call] = docker.calls;
    expect(call?.args).toEqual([
      "exec",
      "--interactive",
      "--user",
      "paseo",
      "paseo-sandbox-abc",
      "codex",
      "login",
    ]);
    expect(call?.options.stdin).toBe("secret\n");
  });
});

describe("cleanup and availability", () => {
  test("stop and destroy tolerate a sandbox that is already gone", async () => {
    const provider = createDockerProvider(docker.cli);
    await expect(provider.stop("paseo-sandbox-abc")).resolves.toBeUndefined();
    await expect(provider.destroy({ key: "abc", handle: null })).resolves.toBeUndefined();
  });

  test("destroy finds the sandbox by key when no handle was recorded", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up(spec, phases);
    await provider.destroy({ key: "abc", handle: null });
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  test("an unreachable Docker daemon is explained", async () => {
    docker.daemonDown = true;
    expect(await createDockerProvider(docker.cli).unavailable()).toContain("Start Docker");
  });

  test("a missing docker binary is explained", async () => {
    const provider = createDockerProvider(async () => {
      throw new DockerError("Docker is not installed on the Paseo host", "");
    });
    expect(await provider.unavailable()).toContain("not installed");
  });
});
