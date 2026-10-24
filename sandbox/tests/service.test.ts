import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ExecRequest,
  HostMount,
  SandboxProvider,
  SandboxRef,
  SandboxRuntimeStatus,
  SandboxSpec,
} from "../server/provider";
import { parseRepository } from "../server/repository";
import { createSandboxService, type SandboxService } from "../server/service";
import { Store } from "../server/store";
import { FakeHosts } from "./support";

const offer = {
  v: 2,
  serverId: "srv_box",
  daemonPublicKeyB64: "key",
  relay: { endpoint: "relay.example.test:443", useTls: true },
};

/** A provider that records what it is asked and answers like a healthy sandbox would. */
class FakeProvider implements SandboxProvider {
  readonly id = "fake";
  ups: SandboxSpec[] = [];
  execs: ExecRequest[] = [];
  destroyed: SandboxRef[] = [];
  runtime = new Map<string, SandboxRuntimeStatus>();
  problem: string | null = null;
  failOn: { match: string; message: string } | null = null;
  private pairings = 0;

  constructor(private readonly leak: () => Promise<string>) {}

  async unavailable() {
    return this.problem;
  }

  async up(spec: SandboxSpec) {
    this.ups.push(spec);
    this.runtime.set(`h-${spec.key}`, "running");
    return `h-${spec.key}`;
  }

  async status(handle: string) {
    return this.runtime.get(handle) ?? "missing";
  }

  async exec(request: ExecRequest) {
    this.execs.push(request);
    const command = request.argv.join(" ");
    if (this.failOn && command.includes(this.failOn.match)) {
      const detail = this.failOn.message === "LEAK" ? await this.leak() : this.failOn.message;
      throw new Error(`exec failed ${detail}`);
    }
    if (request.argv[0] === "test") throw new Error("missing");
    if (request.argv[0] !== "paseo") return "";
    // A recreated sandbox can be offered another relay, so the connection can change.
    const relay = { endpoint: `relay${this.pairings++}.example.test:443`, useTls: true };
    const encoded = Buffer.from(JSON.stringify({ ...offer, relay })).toString("base64url");
    return JSON.stringify({ url: `https://app.paseo.sh/#offer=${encoded}` });
  }

  async stop(handle: string) {
    this.runtime.set(handle, "stopped");
  }

  async destroy(target: SandboxRef) {
    this.destroyed.push(target);
    this.runtime.delete(`h-${target.key}`);
  }

  commands() {
    return this.execs.map((request) => request.argv.join(" "));
  }
}

interface Harness {
  service: SandboxService;
  /** What the host-mount resolver was asked for, and the failure it should give instead. */
  mounts: { requests: (readonly string[])[]; error: string | null; githubToken: string };
  store: Store;
  hosts: FakeHosts;
  provider: FakeProvider;
}

const SHARED_CODEX: HostMount = {
  source: "/host/.codex",
  target: "/home/paseo/.codex",
  readOnly: false,
};

async function harness(): Promise<Harness> {
  const store = new Store(join(await mkdtemp(join(tmpdir(), "sandbox-service-")), "state.json"));
  const provider = new FakeProvider(async () => {
    const state = await store.read();
    const password = Object.values(state.sandboxes)[0]?.password;
    return `fatal: auth ${state.credentials.GITHUB_TOKEN?.value} ${password}`;
  });
  const mounts: Harness["mounts"] = { requests: [], error: null, githubToken: "gho_host_token" };
  return {
    service: createSandboxService(provider, store, {
      async mounts(enabled) {
        mounts.requests.push(enabled);
        if (mounts.error) throw new Error(mounts.error);
        return enabled.includes("codex") ? [SHARED_CODEX] : [];
      },
      async githubToken() {
        return mounts.githubToken;
      },
    }),
    mounts,
    store,
    hosts: new FakeHosts(),
    provider,
  };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

const create = (name = "n", repoUrl = "a/b") => h.service.create(h.hosts, { name, repoUrl });
const listed = async () => (await h.service.list(h.hosts)).sandboxes;

async function settle(id: string) {
  await vi.waitFor(async () => {
    expect((await listed()).find((s) => s.id === id)?.busy).toBeNull();
  });
  return (await listed()).find((s) => s.id === id);
}

async function saveCredential(name: string, value: string) {
  await h.store.update((draft) => {
    draft.credentials[name] = { value, savedAt: "2026-01-01" };
  });
}

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
    await saveCredential("ANTHROPIC_API_KEY", "sk-1");
    await saveCredential("CODEX_API_KEY", "sk-codex");
    const { id } = await create("Hello", "octocat/Hello-World");

    expect(await settle(id)).toMatchObject({
      runtime: "running",
      error: null,
      stale: false,
      host: { status: "online" },
    });
    const [spec] = h.provider.ups;
    expect(spec?.env.ANTHROPIC_API_KEY).toBe("sk-1");
    expect(spec?.env.PASEO_PASSWORD).toMatch(/^[\w-]{32}$/);
    // Codex ignores the variable, so it is signed in through stdin and kept out of the environment.
    expect(spec?.env.CODEX_API_KEY).toBeUndefined();
    expect(h.provider.execs.find((request) => request.argv[0] === "codex")).toMatchObject({
      argv: ["codex", "login", "--with-api-key"],
      stdin: "sk-codex\n",
    });
    expect(h.provider.commands()).toContain(
      "git clone -- https://github.com/octocat/Hello-World /home/paseo/Hello-World.partial",
    );
    expect(h.provider.commands()).toContain(
      "mv -T /home/paseo/Hello-World.partial /home/paseo/Hello-World",
    );
    expect(h.hosts.opened).toEqual(["/home/paseo/Hello-World"]);
  });

  test("a shared login is mounted, replaces the Codex sign-in, and marks a running sandbox stale", async () => {
    await saveCredential("CODEX_API_KEY", "sk-codex");
    const { id } = await create();
    await settle(id);
    expect(h.provider.commands()).toContain("codex login --with-api-key");

    await h.store.update((draft) => {
      draft.hostLogins = ["codex"];
    });
    expect((await settle(id))?.stale).toBe(true);
    h.provider.execs.length = 0;
    await h.service.start(h.hosts, id);

    expect((await settle(id))?.stale).toBe(false);
    expect(h.mounts.requests.at(-1)).toEqual(["codex"]);
    expect(h.provider.ups.at(-1)?.mounts).toEqual([SHARED_CODEX]);
    // Signing in or out would rewrite the host's own auth.json.
    expect(h.provider.commands().filter((command) => command.startsWith("codex"))).toEqual([]);
  });

  test("a shared GitHub login replaces the saved token, and the host's token is kept out of failures", async () => {
    await saveCredential("GITHUB_TOKEN", "ghp_saved_token");
    await h.store.update((draft) => {
      draft.hostLogins = ["github"];
    });
    h.provider.failOn = { match: "git clone", message: "fatal: bad credentials gho_host_token" };
    const { id } = await create();

    const failed = await settle(id);

    expect(h.provider.ups[0]?.env.GITHUB_TOKEN).toBe("gho_host_token");
    expect(failed?.error).toContain("fatal: bad credentials ***");
    expect(failed?.error).not.toContain("gho_host_token");
  });

  test("a login that cannot be shared stops the start with the reason and changes nothing", async () => {
    await h.store.update((draft) => {
      draft.hostLogins = ["claude"];
    });
    h.mounts.error = "Cannot share the claude login: /h/.claude does not exist";
    const { id } = await create();

    expect((await settle(id))?.error).toContain("does not exist");
    expect(h.provider.ups).toEqual([]);
  });

  test("every start turns the OMP provider on and reloads the daemon before signing agents in", async () => {
    await saveCredential("CODEX_API_KEY", "sk-codex");
    const { id } = await create();
    await settle(id);
    await h.service.stop(id);
    await settle(id);
    await h.service.start(h.hosts, id);
    await settle(id);

    const commands = h.provider.execs.map((request) =>
      request.argv[0] === "node" ? "enable-omp" : request.argv.join(" "),
    );
    const relevant = commands.filter(
      (c) => c === "enable-omp" || c === "paseo reload" || c.startsWith("codex login"),
    );
    expect(relevant).toEqual([
      "enable-omp",
      "paseo reload",
      "codex login --with-api-key",
      "enable-omp",
      "paseo reload",
      "codex login --with-api-key",
    ]);
  });

  test("a listing never carries the daemon password or a credential value", async () => {
    await saveCredential("GITHUB_TOKEN", "ghp_secret_value");
    const { id } = await create();
    await settle(id);
    const password = (await h.store.read()).sandboxes[id]?.password ?? "";
    const listing = JSON.stringify(await h.service.list(h.hosts));
    expect(password).toHaveLength(32);
    expect(listing).not.toContain("ghp_secret_value");
    expect(listing).not.toContain(password);
  });

  test("changing a credential marks a running sandbox stale, and the next start applies it", async () => {
    const { id } = await create();
    await settle(id);
    await saveCredential("GITHUB_TOKEN", "new");
    expect((await settle(id))?.stale).toBe(true);

    await h.service.stop(id);
    expect((await settle(id))?.runtime).toBe("stopped");
    await h.service.start(h.hosts, id);

    expect((await settle(id))?.stale).toBe(false);
    expect(h.provider.ups.at(-1)?.env.GITHUB_TOKEN).toBe("new");
    expect(h.provider.ups.at(-1)?.revision).not.toBe(h.provider.ups[0]?.revision);
  });

  test("a failed clone is reported with a way to fix it, and a retry does not repeat finished work", async () => {
    h.provider.failOn = { match: "git clone", message: "" };
    const { id } = await create();
    expect((await settle(id))?.error).toContain("save a GitHub token in Sandbox settings");
    expect(h.hosts.opened).toEqual([]);

    h.provider.failOn = null;
    await h.service.start(h.hosts, id);
    expect((await settle(id))?.error).toBeNull();
    expect(h.hosts.opened).toEqual(["/home/paseo/b"]);
  });

  test("a failed sign-out leaves the sandbox stale, so the removed credential is not reported as applied", async () => {
    await saveCredential("CODEX_API_KEY", "sk-codex");
    const { id } = await create();
    await settle(id);
    await h.store.update((draft) => {
      delete draft.credentials.CODEX_API_KEY;
    });
    h.provider.failOn = { match: "codex logout", message: "" };

    await h.service.start(h.hosts, id);
    const failed = await settle(id);

    expect(failed?.error).toContain("exec failed");
    expect(failed?.stale).toBe(true);
  });

  test("starting again updates the registered host, and leaves its label and metadata alone", async () => {
    const { id } = await create();
    await settle(id);
    await h.service.stop(id);
    await settle(id);
    await h.service.start(h.hosts, id);

    expect((await settle(id))?.error).toBeNull();
    expect(h.hosts.rows).toHaveLength(1);
    expect(h.hosts.updates).toHaveLength(1);
    expect(h.hosts.updates[0]?.replaceIdentity).toBe(true);
    // Edits made in Connected hosts survive a restart.
    expect(Object.keys(h.hosts.updates[0] ?? {}).sort()).toEqual([
      "connection",
      "enabled",
      "replaceIdentity",
    ]);
  });

  test("failure text never carries a saved value or the daemon password", async () => {
    await saveCredential("GITHUB_TOKEN", "ghp_leaky_value");
    h.provider.failOn = { match: "git clone", message: "LEAK" };
    const { id } = await create();
    await settle(id);
    const error = (await listed())[0]?.error ?? "";
    expect(error).toContain("fatal: auth *** ***");
    expect(error).not.toContain("ghp_leaky_value");
  });

  test("remove still cleans up a sandbox whose handle was never recorded", async () => {
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
    await h.service.remove(h.hosts, "orphan");
    await vi.waitFor(async () => expect(await listed()).toEqual([]));
    expect(h.provider.destroyed).toEqual([{ key: "orphan", handle: null }]);
  });

  test("a listing carries the daemon's reason when the host cannot connect", async () => {
    const { id } = await create();
    await settle(id);
    const [row] = h.hosts.rows;
    if (!row) throw new Error("the sandbox registered no host");
    row.status = "error";
    row.error = { code: "auth", message: "Authentication failed" };

    expect((await listed())[0]?.host).toEqual({
      status: "error",
      serverId: "srv_box",
      error: "Authentication failed",
    });
  });

  test("a sandbox refuses a second operation while one is running", async () => {
    const { id } = await create();
    await expect(h.service.start(h.hosts, id)).rejects.toThrow("busy");
    await settle(id);
  });

  test("remove deletes the runtime, the registered host and the record", async () => {
    const { id } = await create();
    await settle(id);
    await h.service.remove(h.hosts, id);
    await vi.waitFor(async () => expect(await listed()).toEqual([]));
    expect(h.provider.runtime.size).toBe(0);
    expect(h.hosts.rows).toEqual([]);
  });

  test("create fails fast, and creates nothing, when the runtime is unavailable", async () => {
    h.provider.problem = "Docker is not running.";
    await expect(create()).rejects.toThrow("Docker is not running.");
    expect(Object.keys((await h.store.read()).sandboxes)).toEqual([]);
  });
});
