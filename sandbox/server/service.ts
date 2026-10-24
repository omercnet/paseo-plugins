import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { CREDENTIAL_PRESETS, type CredentialSummary } from "../shared/credentials";
import type { Sandbox } from "../shared/sandbox";
import { relayConnection } from "./pairing";
import type { SandboxProvider } from "./provider";
import type { SandboxRecord, State, Store } from "./store";

const ONLINE_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `owner/repo` on GitHub or an https URL, normalized, plus the checkout directory name. */
export function parseRepository(input: string): { url: string; directory: string } {
  const trimmed = input.trim();
  const url = /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? `https://github.com/${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a repository as owner/repo or an https URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Use an https repository URL without a username or password.");
  const directory = parsed.pathname
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/, "")
    .replace(/[^\w.-]/g, "");
  if (!directory || directory.startsWith("."))
    throw new Error("That URL does not name a repository.");
  return { url: parsed.toString(), directory };
}

export function credentialSummaries(credentials: State["credentials"]): CredentialSummary[] {
  return Object.entries(credentials)
    .map(([name, { savedAt }]) => {
      const preset = CREDENTIAL_PRESETS.find((candidate) => candidate.name === name);
      return {
        name,
        label: preset?.label ?? name,
        kind: preset?.kind ?? ("other" as const),
        savedAt,
        expiresAt: preset?.lifetimeDays
          ? new Date(Date.parse(savedAt) + preset.lifetimeDays * DAY_MS).toISOString()
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loginPreset(name: string) {
  return CREDENTIAL_PRESETS.find((preset) => preset.name === name && "login" in preset);
}

/** What a sandbox starts with: the daemon environment, plus a revision over everything applied. */
function environment(state: State, record: SandboxRecord) {
  const env: Record<string, string> = { PASEO_PASSWORD: record.password };
  for (const [name, { value }] of Object.entries(state.credentials)) {
    if (!loginPreset(name)) env[name] = value;
  }
  const values = Object.fromEntries(
    Object.entries(state.credentials).map(([name, { value }]) => [name, value]),
  );
  const sorted = (record: Record<string, string>) =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  const revision = createHash("sha256")
    .update(JSON.stringify([sorted(env), sorted(values)]))
    .digest("hex");
  return { env, revision };
}

/** Lifecycle of project sandboxes. Long operations run in the background and report through `list`. */
export function createSandboxService(provider: SandboxProvider, store: Store) {
  const busy = new Map<string, string>();
  const failures = new Map<string, string>();

  /** Failure text is logged and shown to every client, so no saved value may appear in it. */
  async function redact(id: string, message: string) {
    const state = await store.read();
    const secrets = [
      state.sandboxes[id]?.password,
      ...Object.values(state.credentials).map((credential) => credential.value),
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
        const message = await redact(id, error instanceof Error ? error.message : String(error));
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

  async function waitOnline(paseo: PaseoApi, registrationId: string) {
    const deadline = Date.now() + ONLINE_TIMEOUT_MS;
    for (;;) {
      const host = (await paseo.hosts.list()).hosts.find(
        (h) => h.registrationId === registrationId,
      );
      if (host?.status === "online" && host.serverId) return host.serverId;
      if (Date.now() > deadline)
        throw new Error(
          host?.error?.message ??
            "The sandbox started but Paseo could not reach it through the relay.",
        );
      await new Promise((done) => setTimeout(done, 1000));
    }
  }

  /** Brings the sandbox up with the current credentials and registers it as a connected host. */
  async function provision(paseo: PaseoApi, id: string, setPhase: (phase: string) => void) {
    const current = await record(id);
    const { env, revision } = environment(await store.read(), current);
    const handle = await provider.up({ key: id, revision, env }, setPhase);
    await store.update((draft) => {
      const target = draft.sandboxes[id];
      if (target) Object.assign(target, { handle, revision });
    });
    setPhase("Signing in agents");
    const state = await store.read();
    for (const preset of CREDENTIAL_PRESETS) {
      if (!("login" in preset)) continue;
      const saved = state.credentials[preset.name];
      // A logout with nothing stored may exit non-zero; the end state is what matters.
      if (saved) await provider.exec(handle, preset.login, { stdin: `${saved.value}\n` });
      else await provider.exec(handle, preset.logout).catch(() => undefined);
    }
    setPhase("Connecting to the sandbox");
    const pairing = JSON.parse(
      await provider.exec(handle, ["paseo", "daemon", "pair", "--relay", "--json"]),
    );
    const connection = relayConnection(String(pairing.url), current.password);
    // Re-adding a source with a changed connection is a conflict, and an update restarts a
    // connection stuck in error. The container is ours, so a recreated identity is expected.
    // Label and metadata are left alone after the first add: Connected hosts may have edited them.
    const existing = (await paseo.hosts.list()).hosts.find((h) => h.source.key === id);
    const host = existing
      ? await paseo.hosts.update(existing.registrationId, {
          connection,
          enabled: true,
          replaceIdentity: true,
        })
      : await paseo.hosts.add({
          connection,
          label: current.name,
          metadata: { sandboxId: id },
          sourceKey: id,
        });
    return waitOnline(paseo, host.registrationId);
  }

  async function checkout(paseo: PaseoApi, id: string, serverId: string) {
    const { handle, repoUrl } = await record(id);
    if (!handle) throw new Error("The sandbox has no runtime to clone into.");
    const { url, directory } = parseRepository(repoUrl);
    const cwd = `/home/paseo/${directory}`;
    const cloned = await provider.exec(handle, ["test", "-d", `${cwd}/.git`]).then(
      () => true,
      () => false,
    );
    if (!cloned) {
      // Clone beside the target and rename, so an interrupted clone is never mistaken for a checkout.
      const partial = `${cwd}.partial`;
      try {
        await provider.exec(handle, ["rm", "-rf", partial]);
        await provider.exec(handle, ["git", "clone", "--", url, partial], {
          timeoutMs: CLONE_TIMEOUT_MS,
        });
        await provider.exec(handle, ["mv", "-T", partial, cwd]);
      } catch (error) {
        throw new Error(
          `Cloning ${url} failed. For a private repository, save a GitHub token in Sandbox settings and start the sandbox again. ${(error as Error).message}`,
        );
      }
    }
    const remote = await paseo.hosts.client(serverId);
    try {
      await remote.workspaces.open({ cwd });
    } finally {
      await remote.dispose();
    }
  }

  async function bringUp(paseo: PaseoApi, id: string, setPhase: (phase: string) => void) {
    const serverId = await provision(paseo, id, setPhase);
    setPhase("Opening the project");
    await checkout(paseo, id, serverId);
  }

  return {
    async list(paseo: PaseoApi) {
      const problem = await provider.unavailable();
      const state = await store.read();
      const hosts = (await paseo.hosts.list()).hosts;
      const sandboxes = await Promise.all(
        Object.values(state.sandboxes).map(async (item): Promise<Sandbox> => {
          const runtime = item.handle && !problem ? await provider.status(item.handle) : "missing";
          const host = hosts.find((h) => h.source.key === item.id);
          return {
            id: item.id,
            name: item.name,
            repoUrl: item.repoUrl,
            createdAt: item.createdAt,
            runtime,
            host: host
              ? { status: host.status, serverId: host.serverId, error: host.error?.message ?? null }
              : null,
            stale: runtime === "running" && item.revision !== environment(state, item).revision,
            busy: busy.get(item.id) ?? null,
            error: failures.get(item.id) ?? null,
          };
        }),
      );
      sandboxes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { runtime: { available: !problem, problem }, sandboxes };
    },

    async create(paseo: PaseoApi, input: { name: string; repoUrl: string }) {
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
      begin(id, "Creating", (setPhase) => bringUp(paseo, id, setPhase));
      return { id };
    },

    async start(paseo: PaseoApi, id: string) {
      await record(id);
      begin(id, "Starting", (setPhase) => bringUp(paseo, id, setPhase));
    },

    async stop(id: string) {
      const { handle } = await record(id);
      begin(id, "Stopping", async () => {
        if (handle) await provider.stop(handle);
      });
    },

    async remove(paseo: PaseoApi, id: string) {
      const { handle } = await record(id);
      begin(id, "Removing", async () => {
        await provider.destroy({ key: id, handle });
        for (const host of (await paseo.hosts.list()).hosts) {
          if (host.source.key === id) await paseo.hosts.remove(host.registrationId);
        }
        await store.update((draft) => {
          delete draft.sandboxes[id];
        });
      });
    },
  };
}
