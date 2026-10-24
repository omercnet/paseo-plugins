import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execDocker } from "../../server/docker/cli";
import { createDockerProvider } from "../../server/docker/provider";

export const provider = createDockerProvider(execDocker);

/** Integration suites exercise real Docker, so a missing daemon is a failure, never a skip. */
export async function requireDocker() {
  const problem = await provider.unavailable();
  if (problem) throw new Error(`Integration tests need Docker: ${problem}`);
}

export function uniqueKey() {
  return `itest-${randomUUID().slice(0, 8)}`;
}

export function docker(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** Runs a command inside the sandbox as its unprivileged user and returns stdout. */
export function inside(handle: string, ...argv: string[]) {
  return provider.exec({ handle, argv });
}

/** The sandbox's container and volume names that still exist. */
export function leftovers(key: string) {
  const filter = `name=paseo-sandbox-${key}`;
  const containers = docker("ps", "-a", "--filter", filter, "--format", "{{.Names}}");
  const volumes = docker("volume", "ls", "--filter", filter, "--format", "{{.Name}}");
  return [...containers.split("\n"), ...volumes.split("\n")].filter(Boolean);
}
