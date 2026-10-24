import { execFile } from "node:child_process";
import { DOCKERFILE, IMAGE_TAG } from "./docker-image";
import type { SandboxProvider, SandboxRuntimeStatus, SandboxSpec } from "./provider";

const REVISION_LABEL = "sh.paseo-plugins.sandbox.revision";
const HEALTH_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;

interface Run {
  stdout: string;
  stderr: string;
}

class DockerError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Runs the docker CLI. `env` reaches the CLI process only, so secrets never appear in argv. */
function docker(
  args: readonly string[],
  options: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Run> {
  const { promise, resolve, reject } = Promise.withResolvers<Run>();
  const child = execFile(
    "docker",
    [...args],
    {
      env: { ...process.env, ...options.env },
      maxBuffer: 16 << 20,
      timeout: options.timeoutMs ?? 120_000,
    },
    (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      const lastLine = stderr.trim().split("\n").at(-1);
      reject(
        new DockerError(
          missing
            ? "Docker is not installed on the Paseo host, or `docker` is not on its PATH."
            : error.killed && error.signal
              ? `docker ${args[0]} timed out after ${(options.timeoutMs ?? 120_000) / 1000}s`
              : `docker ${args[0]} failed: ${lastLine || error.message}`,
          stderr,
        ),
      );
    },
  );
  // A child that exits before reading its stdin must not take the plugin down with an EPIPE.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.stdin);
  return promise;
}

const absent = (error: unknown) =>
  error instanceof DockerError && /no such (container|image|volume|object)/i.test(error.stderr);

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
    if (absent(error)) return null;
    throw error;
  }
}

async function ensureImage(onPhase: (phase: string) => void) {
  try {
    await docker(["image", "inspect", IMAGE_TAG]);
  } catch (error) {
    if (!absent(error)) throw error;
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
    if (Date.now() > deadline)
      throw new Error("The sandbox daemon did not become healthy in 2 minutes.");
    await new Promise((done) => setTimeout(done, 1000));
  }
}

const containerName = (key: string) => `paseo-sandbox-${key}`;
const volumeName = (handle: string) => `${handle}-home`;

/** One container per sandbox, one named volume for /home/paseo. No published ports, no mounts. */
export const dockerProvider: SandboxProvider = {
  id: "docker",

  async unavailable() {
    try {
      await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
      return null;
    } catch (error) {
      if (!(error instanceof DockerError)) throw error;
      if (/cannot connect|is the docker daemon running|permission denied/i.test(error.stderr))
        return "Docker is installed but its daemon is not reachable. Start Docker, or add the Paseo host's user to the docker group.";
      return error.message;
    }
  },

  async up(spec: SandboxSpec, onPhase) {
    const name = containerName(spec.key);
    await ensureImage(onPhase);
    const existing = await inspect(name);
    if (existing && (existing.revision !== spec.revision || existing.image !== IMAGE_TAG)) {
      onPhase("Applying new credentials");
      await docker(["container", "rm", "--force", name]);
    } else if (existing) {
      if (existing.state !== "running") {
        onPhase("Starting the sandbox");
        await docker(["container", "start", name]);
      }
      await waitHealthy(name);
      return name;
    }
    onPhase("Starting the sandbox");
    const volumeExisted = await docker(["volume", "inspect", volumeName(name)]).then(
      () => true,
      (error) => {
        if (absent(error)) return false;
        throw error;
      },
    );
    await docker(["volume", "create", volumeName(name)]);
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
          `${volumeName(name)}:/home/paseo`,
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
      if (!volumeExisted)
        await docker(["volume", "rm", "--force", volumeName(name)]).catch(() => undefined);
      throw error;
    }
    return name;
  },

  async status(handle): Promise<SandboxRuntimeStatus> {
    const container = await inspect(handle);
    if (!container) return "missing";
    return container.state === "running" ? "running" : "stopped";
  },

  async exec(handle, argv, options) {
    const { stdout } = await docker(
      ["exec", "--interactive", "--user", "paseo", handle, ...argv],
      options,
    );
    return stdout;
  },

  async stop(handle) {
    try {
      await docker(["container", "stop", "--time", "10", handle]);
    } catch (error) {
      if (!absent(error)) throw error;
    }
  },

  async destroy({ key }) {
    const handle = containerName(key);
    for (const args of [
      ["container", "rm", "--force", handle],
      ["volume", "rm", "--force", volumeName(handle)],
    ]) {
      try {
        await docker(args);
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
  },
};
