/**
 * A sandbox provider turns a spec into one running sandbox that holds a Paseo daemon, and
 * nothing else: pairing, credentials and host registration stay in the plugin. Handles are
 * opaque to everything outside the provider that issued them.
 */
export interface SandboxSpec {
  /** Stable, unique per sandbox; the provider derives resource names from it. */
  key: string;
  /** Changes whenever `env` does. A sandbox created with another revision is recreated. */
  revision: string;
  /** Becomes the daemon's environment, so every agent, terminal and git command inherits it. */
  env: Readonly<Record<string, string>>;
}

export type SandboxRuntimeStatus = "running" | "stopped" | "missing";

export interface SandboxProvider {
  readonly id: string;
  /** Why this provider cannot run on this machine, or null when it can. */
  unavailable(): Promise<string | null>;
  /**
   * Creates the sandbox if it is missing, starts it, and resolves once the daemon answers.
   * Idempotent. Stored data survives a stop and a recreation for a new revision.
   */
  up(spec: SandboxSpec, onPhase: (phase: string) => void): Promise<string>;
  status(handle: string): Promise<SandboxRuntimeStatus>;
  /**
   * Runs argv as the unprivileged sandbox user and returns stdout. `stdin` keeps secrets out of
   * argv and environment. Rejects on a non-zero exit or when `timeoutMs` (default two minutes)
   * passes.
   */
  exec(
    handle: string,
    argv: readonly string[],
    options?: { stdin?: string; timeoutMs?: number },
  ): Promise<string>;
  /** Stops it and keeps its data. */
  stop(handle: string): Promise<void>;
  /**
   * Removes the sandbox and its data. Idempotent. `handle` is null when `up` never returned one,
   * for example after a crash, so providers must also be able to find the sandbox by `key`.
   */
  destroy(target: { key: string; handle: string | null }): Promise<void>;
}
