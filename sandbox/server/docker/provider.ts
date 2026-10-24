import type { SandboxProvider, SandboxRuntimeStatus, SandboxSpec } from "../provider";
import { type DockerCli, DockerError, isAbsent } from "./cli";
import { DOCKERFILE, IMAGE_TAG } from "./image";

const REVISION_LABEL = "sh.paseo-plugins.sandbox.revision";
const HEALTH_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const DAEMON_UNREACHABLE = /cannot connect|is the docker daemon running|permission denied/i;

function containerName(key: string) {
  return `paseo-sandbox-${key}`;
}

function volumeName(container: string) {
  return `${container}-home`;
}

/**
 * One container per sandbox and one named volume for /home/paseo. No published ports. Host
 * folders are mounted only when the spec asks for them.
 */
export function createDockerProvider(docker: DockerCli): SandboxProvider {
  async function inspect(name: string) {
    try {
      const { stdout } = await docker([
        "container",
        "inspect",
        "--format",
        `{{.State.Status}}|{{.Config.Image}}|{{index .Config.Labels "${REVISION_LABEL}"}}`,
        name,
      ]);
      const [state = "", image = "", revision = ""] = stdout.trim().split("|");
      return { state, image, revision };
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }

  async function ensureImage(onPhase: (phase: string) => void) {
    try {
      await docker(["image", "inspect", IMAGE_TAG]);
    } catch (error) {
      if (!isAbsent(error)) throw error;
      onPhase("Building the runtime image (first run only, a few minutes)");
      // The Dockerfile copies nothing, so it needs no build context.
      await docker(["build", "--tag", IMAGE_TAG, "-"], {
        stdin: DOCKERFILE,
        timeoutMs: BUILD_TIMEOUT_MS,
      });
    }
  }

  async function waitHealthy(name: string) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      const { stdout } = await docker([
        "container",
        "inspect",
        "--format",
        "{{.State.Status}} {{.State.Health.Status}}",
        name,
      ]);
      const [state, health] = stdout.trim().split(" ");
      if (state !== "running") throw new Error(`The sandbox stopped while starting (${state}).`);
      if (health === "healthy") return;
      if (health === "unhealthy") throw new Error("The sandbox daemon reported itself unhealthy.");
      if (Date.now() > deadline)
        throw new Error("The sandbox daemon did not become healthy in 2 minutes.");
      await new Promise((done) => setTimeout(done, 1000));
    }
  }

  async function volumeExists(name: string) {
    try {
      await docker(["volume", "inspect", name]);
      return true;
    } catch (error) {
      if (isAbsent(error)) return false;
      throw error;
    }
  }

  async function removeIfPresent(args: readonly string[]) {
    try {
      await docker(args);
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
  }

  async function create(name: string, spec: SandboxSpec) {
    const volume = volumeName(name);
    const volumeHeldData = await volumeExists(volume);
    await docker(["volume", "create", volume]);
    try {
      await docker(
        [
          "run",
          "--detach",
          "--name",
          name,
          "--label",
          `${REVISION_LABEL}=${spec.revision}`,
          "--volume",
          `${volume}:/home/paseo`,
          // `--mount` fails on a missing source, where `--volume` would create it on the host.
          ...spec.mounts.flatMap(({ source, target, readOnly }) => [
            "--mount",
            `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`,
          ]),
          "--security-opt",
          "no-new-privileges",
          // The image entrypoint starts as root only to prepare the volume and drop to `paseo`.
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "SETUID",
          "--cap-add",
          "SETGID",
          "--cap-add",
          "DAC_OVERRIDE",
          "--health-interval",
          "2s",
          "--health-start-period",
          "0s",
          ...Object.keys(spec.env).flatMap((variable) => ["--env", variable]),
          IMAGE_TAG,
        ],
        { env: spec.env },
      );
      await waitHealthy(name);
    } catch (error) {
      // Remove what this call made. A volume that already held data is never deleted here.
      await docker(["container", "rm", "--force", name]).catch(() => undefined);
      if (!volumeHeldData) await docker(["volume", "rm", "--force", volume]).catch(() => undefined);
      throw error;
    }
  }

  return {
    id: "docker",

    async unavailable() {
      try {
        await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
        return null;
      } catch (error) {
        if (!(error instanceof DockerError)) throw error;
        if (DAEMON_UNREACHABLE.test(error.stderr))
          return "Docker is installed but its daemon is not reachable. Start Docker, or add the Paseo host's user to the docker group.";
        return error.message;
      }
    },

    async up(spec, onPhase) {
      const name = containerName(spec.key);
      await ensureImage(onPhase);
      const existing = await inspect(name);
      const outdated =
        existing && (existing.revision !== spec.revision || existing.image !== IMAGE_TAG);
      if (existing && !outdated) {
        if (existing.state !== "running") {
          onPhase("Starting the sandbox");
          await docker(["container", "start", name]);
        }
        await waitHealthy(name);
        return name;
      }
      if (outdated) {
        onPhase("Applying new credentials");
        await docker(["container", "rm", "--force", name]);
      }
      onPhase("Starting the sandbox");
      await create(name, spec);
      return name;
    },

    async status(handle): Promise<SandboxRuntimeStatus> {
      const container = await inspect(handle);
      if (!container) return "missing";
      return container.state === "running" ? "running" : "stopped";
    },

    async exec({ handle, argv, stdin, timeoutMs }) {
      const { stdout } = await docker(
        ["exec", "--interactive", "--user", "paseo", handle, ...argv],
        { stdin, timeoutMs },
      );
      return stdout;
    },

    stop(handle) {
      return removeIfPresent(["container", "stop", "--time", "10", handle]);
    },

    async destroy({ key }) {
      const name = containerName(key);
      await removeIfPresent(["container", "rm", "--force", name]);
      await removeIfPresent(["volume", "rm", "--force", volumeName(name)]);
    },
  };
}
