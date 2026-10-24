import { createHash } from "node:crypto";
import {
  CREDENTIAL_PRESETS,
  type CredentialSummary,
  HOST_LOGINS,
  type HostLoginId,
} from "../shared/credentials";
import type { SandboxRecord, State, Store } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;

function summarize(name: string, savedAt: string): CredentialSummary {
  const preset = CREDENTIAL_PRESETS.find((candidate) => candidate.name === name);
  const expiresAt = preset?.lifetimeDays
    ? new Date(Date.parse(savedAt) + preset.lifetimeDays * DAY_MS).toISOString()
    : null;
  return {
    name,
    label: preset?.label ?? name,
    kind: preset?.kind ?? "other",
    savedAt,
    expiresAt,
  };
}

export function credentialSummaries(credentials: State["credentials"]): CredentialSummary[] {
  return Object.entries(credentials)
    .map(([name, { savedAt }]) => summarize(name, savedAt))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Credentials the daemon's own environment cannot carry: the CLI is signed in instead. */
export function isLoginCredential(name: string) {
  return CREDENTIAL_PRESETS.some((preset) => preset.name === name && "login" in preset);
}

function isSharedInstead(name: string, shared: readonly HostLoginId[]) {
  return CREDENTIAL_PRESETS.some(
    (preset) => preset.name === name && "hostLogin" in preset && shared.includes(preset.hostLogin),
  );
}

function sortedEntries(values: Record<string, string>) {
  return Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
}

/** The shared host logins, in a stable order. Unknown ids in an old state file are dropped. */
export function enabledHostLogins(state: State): HostLoginId[] {
  return HOST_LOGINS.map((login) => login.id).filter((id) => state.hostLogins.includes(id));
}

export interface SandboxEnvironment {
  env: Record<string, string>;
  hostLogins: HostLoginId[];
  /** Changes when the environment or any applied credential does. */
  revision: string;
}

export function sandboxEnvironment(state: State, sandbox: SandboxRecord): SandboxEnvironment {
  const env: Record<string, string> = { PASEO_PASSWORD: sandbox.password };
  const applied: Record<string, string> = {};
  const hostLogins = enabledHostLogins(state);
  for (const [name, { value }] of Object.entries(state.credentials)) {
    // A shared login replaces its saved value: the tool would otherwise prefer the saved one.
    if (isSharedInstead(name, hostLogins)) continue;
    applied[name] = value;
    if (!isLoginCredential(name)) env[name] = value;
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([sortedEntries(env), sortedEntries(applied), hostLogins]))
    .digest("hex");
  return { env, hostLogins, revision };
}

export interface SavedCredentials {
  list(): Promise<CredentialSummary[]>;
  save(name: string, value: string): Promise<CredentialSummary[]>;
  remove(name: string): Promise<CredentialSummary[]>;
  hostLogins(): Promise<{ id: HostLoginId; enabled: boolean }[]>;
  setHostLogin(id: HostLoginId, enabled: boolean): Promise<{ id: HostLoginId; enabled: boolean }[]>;
}

export function savedCredentials(store: Store): SavedCredentials {
  async function list() {
    return credentialSummaries((await store.read()).credentials);
  }
  async function hostLogins() {
    const enabled = enabledHostLogins(await store.read());
    return HOST_LOGINS.map(({ id }) => ({ id, enabled: enabled.includes(id) }));
  }
  return {
    list,
    hostLogins,
    async setHostLogin(id, enabled) {
      await store.update((draft) => {
        draft.hostLogins = draft.hostLogins.filter((entry) => entry !== id);
        if (enabled) draft.hostLogins.push(id);
      });
      return hostLogins();
    },
    async save(name, value) {
      await store.update((draft) => {
        draft.credentials[name] = { value, savedAt: new Date().toISOString() };
      });
      return list();
    },
    async remove(name) {
      await store.update((draft) => {
        delete draft.credentials[name];
      });
      return list();
    },
  };
}
