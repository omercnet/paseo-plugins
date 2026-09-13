import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_SETTINGS_BYTES = 64 * 1024;

/** Root of omp's per-machine agent state (`agent.db`, `history.db`, `memories/`). */
export function ompAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  return (
    environment.PASEO_OMP_AGENT_DIR ??
    environment.OMP_AGENT_DIR ??
    environment.PI_CODING_AGENT_DIR ??
    join(home, environment.PI_CONFIG_DIR ?? ".omp", "agent")
  );
}

function configuredSessionDir(agentDir: string): string | undefined {
  for (const settingsPath of [
    join(agentDir, "settings.json"),
    join(agentDir, "..", "settings.json"),
  ]) {
    let descriptor: number;
    try {
      descriptor = openSync(
        settingsPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch {
      continue;
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) continue;
      const buffer = Buffer.allocUnsafe(stat.size);
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const value = (parsed as Record<string, unknown>).sessionDir;
      if (
        typeof value !== "string" ||
        !value ||
        value.includes("\0") ||
        Buffer.byteLength(value) > 4_096
      )
        continue;
      return isAbsolute(value) ? value : resolve(dirname(settingsPath), value);
    } catch {
    } finally {
      closeSync(descriptor);
    }
  }
  return;
}

/** OMP's effective session root, honoring its documented environment and settings precedence. */
export function ompSessionDir(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.OMP_SESSION_DIR ?? environment.PI_CODING_AGENT_SESSION_DIR;
  if (explicit) return resolve(explicit);
  const agentDir = ompAgentDir(environment);
  return configuredSessionDir(agentDir) ?? join(agentDir, "sessions");
}
