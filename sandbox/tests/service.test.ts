import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SandboxProvider, SandboxSpec } from "../server/provider";
import { createSandboxService, parseRepository } from "../server/service";
import { Store } from "../server/store";

const offer = Buffer.from(
  JSON.stringify({
    v: 2,
    serverId: "srv_box",
    daemonPublicKeyB64: "key",
    relay: { endpoint: "relay.example.test:443", useTls: true },
  }),
).toString("base64url");

interface Harness {
  service: ReturnType<typeof createSandboxService>;
  store: Store;
  paseo: PaseoApi;
  ups: SandboxSpec[];
  execs: { argv: readonly string[]; stdin?: string }[];
  hosts: {
    registrationId: string;
    status: string;
    serverId: string | null;
    metadata: Record<string, string>;
    source: { key: string };
    connection: string;
    error?: { code: string; message: string };
  }[];
  updates: { connection: string; replaceIdentity: boolean }[];
  opened: string[];
  provider: SandboxProvider;
  failExec: (match: string, message?: string) => void;
  runtime: Map<string, "running" | "stopped">;
}

async function harness(): Promise<Harness> {
  const store = new Store(join(await mkdtemp(join(tmpdir(), "sandbox-service-")), "state.json"));
  const ups: SandboxSpec[] = [];
  const execs: Harness["execs"] = [];
  const runtime = new Map<string, "running" | "stopped">();
  let failing: string | null = null;
  let failMessage = "";
  let pairings = 0;
  const leak = async () => {
    const state = await store.read();
    const password = Object.values(state.sandboxes)[0]?.password;
    return `fatal: auth ${state.credentials.GITHUB_TOKEN?.value} ${password}`;
  };
  const provider: SandboxProvider = {
    id: "fake",
    unavailable: async () => null,
    async up(spec) {
      ups.push(spec);
      runtime.set(`h-${spec.key}`, "running");
      return `h-${spec.key}`;
    },
    status: async (handle) => runtime.get(handle) ?? "missing",
    async exec(_handle, argv, options) {
      execs.push({ argv, stdin: options?.stdin });
      if (failing && argv.join(" ").includes(failing))
        throw new Error(`exec failed ${failMessage === "LEAK" ? await leak() : failMessage}`);
      if (argv[0] === "test") throw new Error("missing");
      if (argv[0] === "paseo") {
        // A recreated sandbox can be offered a different relay, so the connection can change.
        const relay = { endpoint: `relay${pairings++}.example.test:443`, useTls: true };
        const changed = JSON.parse(Buffer.from(offer, "base64url").toString("utf8"));
        const next = Buffer.from(JSON.stringify({ ...changed, relay })).toString("base64url");
        return JSON.stringify({ url: `https://app.paseo.sh/#offer=${next}` });
      }
      return "";
    },
    stop: async (handle) => void runtime.set(handle, "stopped"),
    destroy: async ({ key }) => void runtime.delete(`h-${key}`),
  };
  const hosts: Harness["hosts"] = [];
  const opened: string[] = [];
  const updates: Harness["updates"] = [];
  const paseo = {
    hosts: {
      list: async () => ({ hosts }),
      async add(input: {
        connection: string;
        sourceKey: string;
        metadata: Record<string, string>;
      }) {
        if (hosts.some((h) => h.source.key === input.sourceKey)) throw new Error("source_conflict");
        const host = {
          registrationId: `reg-${input.sourceKey}`,
          status: "online",
          serverId: "srv_box",
          metadata: input.metadata,
          source: { key: input.sourceKey },
          connection: input.connection,
        };
        hosts.push(host);
        return host;
      },
      async update(
        registrationId: string,
        patch: { connection: string; replaceIdentity: boolean },
      ) {
        updates.push(patch);
        const host = hosts.find((h) => h.registrationId === registrationId);
        if (!host) throw new Error("unknown host");
        host.connection = patch.connection;
        host.status = "online";
        return host;
      },
      remove: async (registrationId: string) => {
        hosts.splice(
          hosts.findIndex((h) => h.registrationId === registrationId),
          1,
        );
      },
      client: async () => ({
        workspaces: { open: async ({ cwd }: { cwd: string }) => void opened.push(cwd) },
        dispose: async () => undefined,
      }),
    },
  } as unknown as PaseoApi;
  return {
    service: createSandboxService(provider, store),
    store,
    paseo,
    ups,
    execs,
    hosts,
    updates,
    opened,
    provider,
    runtime,
    failExec: (match, message = "") => {
      failing = match;
      failMessage = message;
    },
  };
}

const settle = async (h: Harness, id: string) => {
  await vi.waitFor(async () => {
    const found = (await h.service.list(h.paseo)).sandboxes.find((s) => s.id === id);
    expect(found?.busy).toBeNull();
  });
  return (await h.service.list(h.paseo)).sandboxes.find((s) => s.id === id);
};

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe("parseRepository", () => {
  test("normalizes owner/repo and rejects URLs that could leak or misroute credentials", () => {
    expect(parseRepository("octocat/Hello-World")).toEqual({
      url: "https://github.com/octocat/Hello-World",
      directory: "Hello-World",
    });
    expect(parseRepository("https://example.test/a/b.git").directory).toBe("b");
    expect(() => parseRepository("http://github.com/a/b")).toThrow("https");
    expect(() => parseRepository("https://user:pw@github.com/a/b")).toThrow("without a username");
    expect(() => parseRepository("git@github.com:a/b.git")).toThrow();
  });
});

describe("sandbox lifecycle", () => {
  test("create provisions, registers the host, clones and opens the project", async () => {
    await h.store.update((draft) => {
      draft.credentials.ANTHROPIC_API_KEY = { value: "sk-1", savedAt: "2026-01-01" };
      draft.credentials.CODEX_API_KEY = { value: "sk-codex", savedAt: "2026-01-01" };
    });
    const { id } = await h.service.create(h.paseo, {
      name: "Hello",
      repoUrl: "octocat/Hello-World",
    });
    const sandbox = await settle(h, id);

    expect(sandbox).toMatchObject({
      runtime: "running",
      error: null,
      stale: false,
      host: { status: "online" },
    });
    const [spec] = h.ups;
    expect(spec?.env.ANTHROPIC_API_KEY).toBe("sk-1");
    expect(spec?.env.PASEO_PASSWORD).toMatch(/^[\w-]{32}$/);
    // Codex ignores the variable, so it is signed in through stdin and kept out of the environment.
    expect(spec?.env.CODEX_API_KEY).toBeUndefined();
    expect(h.execs.find((e) => e.argv[0] === "codex")).toEqual({
      argv: ["codex", "login", "--with-api-key"],
      stdin: "sk-codex\n",
    });
    expect(
      h.execs.some(
        (e) =>
          e.argv.join(" ") ===
          "git clone -- https://github.com/octocat/Hello-World /home/paseo/Hello-World.partial",
      ),
    ).toBe(true);
    expect(
      h.execs.some(
        (e) => e.argv.join(" ") === "mv -T /home/paseo/Hello-World.partial /home/paseo/Hello-World",
      ),
    ).toBe(true);
    expect(h.opened).toEqual(["/home/paseo/Hello-World"]);
  });

  test("a listing never carries the daemon password or a credential value", async () => {
    await h.store.update((draft) => {
      draft.credentials.GITHUB_TOKEN = { value: "ghp_secret_value", savedAt: "2026-01-01" };
    });
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    await settle(h, id);
    const record = (await h.store.read()).sandboxes[id];
    const listing = JSON.stringify(await h.service.list(h.paseo));
    expect(listing).not.toContain("ghp_secret_value");
    expect(record?.password).toHaveLength(32);
    expect(listing).not.toContain(record?.password as string);
  });

  test("changing a credential marks a running sandbox stale, and the next start applies it", async () => {
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    await settle(h, id);
    await h.store.update((draft) => {
      draft.credentials.GITHUB_TOKEN = { value: "new", savedAt: "2026-01-01" };
    });
    expect((await settle(h, id))?.stale).toBe(true);

    await h.service.stop(id);
    expect((await settle(h, id))?.runtime).toBe("stopped");
    await h.service.start(h.paseo, id);
    const restarted = await settle(h, id);
    expect(restarted?.stale).toBe(false);
    expect(h.ups.at(-1)?.env.GITHUB_TOKEN).toBe("new");
    expect(h.ups.at(-1)?.revision).not.toBe(h.ups[0]?.revision);
  });

  test("a failed clone is reported with a way to fix it, and a retry does not repeat finished work", async () => {
    h.failExec("git clone");
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    const failed = await settle(h, id);
    expect(failed?.error).toContain("save a GitHub token in Sandbox settings");
    expect(h.opened).toEqual([]);

    h.failExec("never");
    await h.service.start(h.paseo, id);
    expect((await settle(h, id))?.error).toBeNull();
    expect(h.opened).toEqual(["/home/paseo/b"]);
  });

  test("starting again updates the registered host when its connection changed", async () => {
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    await settle(h, id);
    await h.service.stop(id);
    await settle(h, id);
    await h.service.start(h.paseo, id);
    expect((await settle(h, id))?.error).toBeNull();
    expect(h.hosts).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.replaceIdentity).toBe(true);
    // Edits made in Connected hosts survive a restart.
    expect(Object.keys(h.updates[0] ?? {}).sort()).toEqual([
      "connection",
      "enabled",
      "replaceIdentity",
    ]);
  });

  test("failure text never carries a saved value or the daemon password", async () => {
    await h.store.update((draft) => {
      draft.credentials.GITHUB_TOKEN = { value: "ghp_leaky_value", savedAt: "2026-01-01" };
    });
    h.failExec("git clone", "LEAK");
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    await settle(h, id);
    const error = (await h.service.list(h.paseo)).sandboxes[0]?.error ?? "";
    expect(error).toContain("fatal: auth *** ***");
    expect(error).not.toContain("ghp_leaky_value");
  });

  test("remove still cleans up a sandbox whose handle was never recorded", async () => {
    const destroy = vi.spyOn(h.provider, "destroy");
    await h.store.update((draft) => {
      draft.sandboxes.orphan = {
        id: "orphan",
        name: "o",
        repoUrl: "https://github.com/a/b",
        handle: null,
        revision: null,
        password: "p",
        createdAt: "2026-01-01",
      };
    });
    await h.service.remove(h.paseo, "orphan");
    await vi.waitFor(async () => expect((await h.service.list(h.paseo)).sandboxes).toEqual([]));
    expect(destroy).toHaveBeenCalledWith({ key: "orphan", handle: null });
  });

  test("a listing carries the daemon's reason when the host cannot connect", async () => {
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    await settle(h, id);
    const host = h.hosts[0];
    if (!host) throw new Error("no host");
    host.status = "error";
    host.error = { code: "auth", message: "Authentication failed" };
    expect((await h.service.list(h.paseo)).sandboxes[0]?.host).toEqual({
      status: "error",
      serverId: "srv_box",
      error: "Authentication failed",
    });
  });

  test("a sandbox refuses a second operation while one is running", async () => {
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    await expect(h.service.start(h.paseo, id)).rejects.toThrow("busy");
    await settle(h, id);
  });

  test("remove deletes the runtime, the registered host and the record", async () => {
    const { id } = await h.service.create(h.paseo, { name: "n", repoUrl: "a/b" });
    await settle(h, id);
    await h.service.remove(h.paseo, id);
    await vi.waitFor(async () => expect((await h.service.list(h.paseo)).sandboxes).toEqual([]));
    expect(h.runtime.size).toBe(0);
    expect(h.hosts).toEqual([]);
  });

  test("create fails fast, and creates nothing, when the runtime is unavailable", async () => {
    h.provider.unavailable = async () => "Docker is not running.";
    await expect(h.service.create(h.paseo, { name: "n", repoUrl: "a/b" })).rejects.toThrow(
      "Docker is not running.",
    );
    expect(Object.keys((await h.store.read()).sandboxes)).toEqual([]);
  });
});
