/**
 * A sandbox provider turns a spec into one running sandbox that holds a Paseo daemon, and
 * nothing else: pairing, credentials and host registration stay in the plugin. Handles are
 * opaque to everything outside the provider that issued them.
 */
/** A host path made visible inside the sandbox. A provider that cannot mount rejects the spec. */
export interface HostMount {
  /** Absolute path on the machine running the provider. */
  source: string;
  /** Absolute path inside the sandbox. */
  target: string;
  readOnly: boolean;
}

export interface SandboxSpec {
  /** Stable, unique per sandbox; the provider derives resource names from it. */
  key: string;
  /** Changes whenever `env` does. A sandbox created with another revision is recreated. */
  revision: string;
  /** Becomes the daemon's environment, so every agent, terminal and git command inherits it. */
  env: Readonly<Record<string, string>>;
  /** Host folders to share. Changing them changes `revision`. */
  mounts: readonly HostMount[];
}

export type SandboxRuntimeStatus = "running" | "stopped" | "missing";

export interface ExecRequest {
  handle: string;
  argv: readonly string[];
  /** Keeps secrets out of argv and the environment. */
  stdin?: string;
  /** Defaults to two minutes. */
  timeoutMs?: number;
}

/** `handle` is null when `up` never returned one, for example after a crash. */
export interface SandboxRef {
  key: string;
  handle: string | null;
}

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
  /** Runs argv as the unprivileged sandbox user and returns stdout. Rejects on a non-zero exit. */
  exec(request: ExecRequest): Promise<string>;
  /** Stops it and keeps its data. */
  stop(handle: string): Promise<void>;
  /** Removes the sandbox and its data. Idempotent. Finds the sandbox by `key` when it has no handle. */
  destroy(target: SandboxRef): Promise<void>;
}
