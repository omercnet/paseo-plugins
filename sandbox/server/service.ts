import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { RpcInput } from "@getpaseo/plugin";
import { CREDENTIAL_PRESETS } from "../shared/credentials";
import type { createSandbox, Sandbox } from "../shared/sandbox";
import { sandboxEnvironment } from "./credentials";
import type { SandboxHosts } from "./hosts";
import { relayConnection } from "./pairing";
import type { HostMount, SandboxProvider } from "./provider";
import { parseRepository } from "./repository";
import type { Store } from "./store";

const ONLINE_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 30 * 60_000;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** What the host contributes when its agent logins are shared. Each rejects with what to fix. */
export interface HostLogins {
  mounts(enabled: readonly string[]): Promise<HostMount[]>;
  githubToken(): Promise<string>;
}

/** Lifecycle of project sandboxes. Long operations run in the background and report through `list`. */
export function createSandboxService(
  provider: SandboxProvider,
  store: Store,
  hostLogins: HostLogins,
) {
  const busy = new Map<string, string>();
  const failures = new Map<string, string>();
  /** Tokens read from the host. They are in no saved state, so redaction must be told. */
  const hostTokens = new Set<string>();

  /** Failure text is logged and shown to every client, so no saved value may appear in it. */
  async function redact(id: string, message: string) {
    const state = await store.read();
    const secrets = [
      state.sandboxes[id]?.password,
      ...Object.values(state.credentials).map((credential) => credential.value),
      ...hostTokens,
    ].filter((secret): secret is string => Boolean(secret) && secret.length >= 8);
    return secrets.reduce((text, secret) => text.split(secret).join("***"), message);
  }

  /** Rejects a second operation on the same sandbox, then runs `work` without blocking the caller. */
  function begin(
    id: string,
    phase: string,
    work: (setPhase: (phase: string) => void) => Promise<void>,
  ) {
    const running = busy.get(id);
    if (running) throw new Error(`This sandbox is busy: ${running.toLowerCase()}.`);
    busy.set(id, phase);
    failures.delete(id);
    void work((next) => busy.set(id, next))
      .catch(async (error: unknown) => {
        const message = await redact(id, messageOf(error));
        console.error(`sandbox ${id}: ${phase} failed: ${message}`);
        failures.set(id, message);
      })
      .finally(() => busy.delete(id));
  }

  async function record(id: string) {
    const found = (await store.read()).sandboxes[id];
    if (!found) throw new Error("That sandbox no longer exists.");
    return found;
  }

  async function waitOnline(hosts: SandboxHosts, registrationId: string) {
    const deadline = Date.now() + ONLINE_TIMEOUT_MS;
    for (;;) {
      const host = (await hosts.list()).find((h) => h.registrationId === registrationId);
      if (host?.status === "online" && host.serverId) return host.serverId;
      if (Date.now() > deadline)
        throw new Error(
          host?.error?.message ??
            "The sandbox started but Paseo could not reach it through the relay.",
        );
      await sleep(1000);
    }
  }

  /** Brings the sandbox up with the current credentials and registers it as a connected host. */
  async function provision(hosts: SandboxHosts, id: string, setPhase: (phase: string) => void) {
    // One snapshot drives the environment, the logins and the recorded revision, so a credential
    // saved meanwhile is reported as stale instead of being half applied.
    const state = await store.read();
    const current = await record(id);
    const { env, hostLogins: shared, revision } = sandboxEnvironment(state, current);
    const mounts = await hostLogins.mounts(shared);
    if (shared.includes("github")) {
      const token = await hostLogins.githubToken();
      hostTokens.add(token);
      env.GITHUB_TOKEN = token;
    }
    const handle = await provider.up({ key: id, revision, env, mounts }, setPhase);
    await store.update((draft) => {
      const target = draft.sandboxes[id];
      if (target) target.handle = handle;
    });
    setPhase("Signing in agents");
    for (const preset of CREDENTIAL_PRESETS) {
      if (!("login" in preset)) continue;
      // A shared login is the host's own file. Signing in or out here would change the host's.
      if (shared.includes(preset.hostLogin)) continue;
      const saved = state.credentials[preset.name];
      if (saved) await provider.exec({ handle, argv: preset.login, stdin: `${saved.value}\n` });
      else await provider.exec({ handle, argv: preset.logout });
    }
    // Only now are the credentials applied. A failed login or logout leaves the sandbox stale.
    await store.update((draft) => {
      const target = draft.sandboxes[id];
      if (target) target.revision = revision;
    });
    setPhase("Connecting to the sandbox");
    const pairing = await provider.exec({
      handle,
      argv: ["paseo", "daemon", "pair", "--relay", "--json"],
    });
    const connection = relayConnection(pairing, current.password);
    // Re-adding a source with a changed connection is a conflict, and an update restarts a
    // connection stuck in error. The container is ours, so a recreated identity is expected.
    // Label and metadata are left alone after the first add: Connected hosts may have edited them.
    const existing = (await hosts.list()).find((h) => h.source.key === id);
    const host = existing
      ? await hosts.update(existing.registrationId, {
          connection,
          enabled: true,
          replaceIdentity: true,
        })
      : await hosts.add({
          connection,
          label: current.name,
          metadata: { sandboxId: id },
          sourceKey: id,
        });
    return waitOnline(hosts, host.registrationId);
  }

  async function checkout(hosts: SandboxHosts, id: string, serverId: string) {
    const { handle, repoUrl } = await record(id);
    if (!handle) throw new Error("The sandbox has no runtime to clone into.");
    const { url, directory } = parseRepository(repoUrl);
    const cwd = `/home/paseo/${directory}`;
    const cloned = await provider.exec({ handle, argv: ["test", "-d", `${cwd}/.git`] }).then(
      () => true,
      () => false,
    );
    if (!cloned) {
      // Clone beside the target and rename, so an interrupted clone is never mistaken for a checkout.
      const partial = `${cwd}.partial`;
      try {
        await provider.exec({ handle, argv: ["rm", "-rf", partial] });
        await provider.exec({
          handle,
          argv: ["git", "clone", "--", url, partial],
          timeoutMs: CLONE_TIMEOUT_MS,
        });
        await provider.exec({ handle, argv: ["mv", "-T", partial, cwd] });
      } catch (error) {
        throw new Error(
          `Cloning ${url} failed. For a private project, save a GitHub token in Sandbox settings and start the sandbox again. ${messageOf(error)}`,
        );
      }
    }
    await hosts.openWorkspace(serverId, cwd);
  }

  async function bringUp(hosts: SandboxHosts, id: string, setPhase: (phase: string) => void) {
    const serverId = await provision(hosts, id, setPhase);
    setPhase("Opening the project");
    await checkout(hosts, id, serverId);
  }

  return {
    async list(hosts: SandboxHosts) {
      const problem = await provider.unavailable();
      const state = await store.read();
      const registered = await hosts.list();
      const sandboxes = await Promise.all(
        Object.values(state.sandboxes).map(async (item): Promise<Sandbox> => {
          const runtime = item.handle && !problem ? await provider.status(item.handle) : "missing";
          const host = registered.find((h) => h.source.key === item.id);
          return {
            id: item.id,
            name: item.name,
            repoUrl: item.repoUrl,
            createdAt: item.createdAt,
            runtime,
            host: host
              ? { status: host.status, serverId: host.serverId, error: host.error?.message ?? null }
              : null,
            stale:
              runtime === "running" && item.revision !== sandboxEnvironment(state, item).revision,
            busy: busy.get(item.id) ?? null,
            error: failures.get(item.id) ?? null,
          };
        }),
      );
      sandboxes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { runtime: { available: !problem, problem }, sandboxes };
    },

    async create(hosts: SandboxHosts, input: RpcInput<typeof createSandbox>) {
      const { url } = parseRepository(input.repoUrl);
      const problem = await provider.unavailable();
      if (problem) throw new Error(problem);
      const id = randomUUID().slice(0, 12);
      await store.update((draft) => {
        draft.sandboxes[id] = {
          id,
          name: input.name,
          repoUrl: url,
          handle: null,
          revision: null,
          password: randomBytes(24).toString("base64url"),
          createdAt: new Date().toISOString(),
        };
      });
      begin(id, "Creating", (setPhase) => bringUp(hosts, id, setPhase));
      return { id };
    },

    async start(hosts: SandboxHosts, id: string) {
      await record(id);
      begin(id, "Starting", (setPhase) => bringUp(hosts, id, setPhase));
    },

    async stop(id: string) {
      const { handle } = await record(id);
      begin(id, "Stopping", async () => {
        if (handle) await provider.stop(handle);
      });
    },

    async remove(hosts: SandboxHosts, id: string) {
      const { handle } = await record(id);
      begin(id, "Removing", async () => {
        await provider.destroy({ key: id, handle });
        for (const host of await hosts.list()) {
          if (host.source.key === id) await hosts.remove(host.registrationId);
        }
        await store.update((draft) => {
          delete draft.sandboxes[id];
        });
      });
    },
  };
}

export type SandboxService = ReturnType<typeof createSandboxService>;
