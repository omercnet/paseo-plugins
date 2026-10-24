import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dockerProvider } from "../../server/docker";

/** Integration suites exercise real Docker, so a missing daemon is a failure, never a skip. */
export async function requireDocker() {
  const problem = await dockerProvider.unavailable();
  if (problem) throw new Error(`Integration tests need Docker: ${problem}`);
}

export const uniqueKey = () => `itest-${randomUUID().slice(0, 8)}`;

export const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

/** The sandbox's container and volume names that still exist. */
export function leftovers(key: string) {
  const containers = docker(
    "ps",
    "-a",
    "--filter",
    `name=paseo-sandbox-${key}`,
    "--format",
    "{{.Names}}",
  );
  const volumes = docker(
    "volume",
    "ls",
    "--filter",
    `name=paseo-sandbox-${key}`,
    "--format",
    "{{.Name}}",
  );
  return [...containers.split("\n"), ...volumes.split("\n")].filter(Boolean);
}
