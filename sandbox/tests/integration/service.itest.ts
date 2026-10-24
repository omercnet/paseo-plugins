import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { dockerProvider } from "../../server/docker";
import { createSandboxService } from "../../server/service";
import { Store } from "../../server/store";
import { docker, leftovers, requireDocker } from "./docker";

interface FakeHost {
  registrationId: string;
  status: "online";
  serverId: string;
  metadata: Record<string, string>;
  source: { key: string };
  connection: string;
}

/** The controller's host registry is faked; everything on the sandbox side is real Docker. */
const hosts: FakeHost[] = [];
const opened: string[] = [];
const paseo = {
  hosts: {
    list: async () => ({ hosts }),
    async add(input: { connection: string; sourceKey: string; metadata: Record<string, string> }) {
      const host: FakeHost = {
        registrationId: `reg-${input.sourceKey}`,
        status: "online",
        serverId: "srv_itest",
        metadata: input.metadata,
        source: { key: input.sourceKey },
        connection: input.connection,
      };
      hosts.push(host);
      return host;
    },
    async update(registrationId: string, patch: { connection: string }) {
      const host = hosts.find((h) => h.registrationId === registrationId) as FakeHost;
      host.connection = patch.connection;
      return host;
    },
    remove: async (registrationId: string) =>
      void hosts.splice(
        hosts.findIndex((h) => h.registrationId === registrationId),
        1,
      ),
    client: async () => ({
      workspaces: { open: async ({ cwd }: { cwd: string }) => void opened.push(cwd) },
      dispose: async () => undefined,
    }),
  },
} as unknown as PaseoApi;

let store: Store;
let service: ReturnType<typeof createSandboxService>;
let id = "";

const only = async () => {
  const [sandbox] = (await service.list(paseo)).sandboxes;
  return sandbox;
};
const idle = () =>
  vi.waitFor(
    async () => {
      const sandbox = await only();
      expect(sandbox?.error).toBeNull();
      expect(sandbox?.busy).toBeNull();
    },
    { timeout: 15 * 60_000, interval: 1000 },
  );
const exec = (...argv: string[]) =>
  docker("exec", "--user", "paseo", `paseo-sandbox-${id}`, ...argv);

beforeAll(async () => {
  await requireDocker();
  store = new Store(join(await mkdtemp(join(tmpdir(), "sandbox-itest-")), "state.json"));
  service = createSandboxService(dockerProvider, store);
  await store.update((draft) => {
    draft.credentials.GITHUB_TOKEN = {
      value: "ghp_itest_token",
      savedAt: new Date().toISOString(),
    };
    draft.credentials.CODEX_API_KEY = {
      value: "sk-itest-codex-key",
      savedAt: new Date().toISOString(),
    };
  });
});
afterAll(async () => {
  if (id) await dockerProvider.destroy({ key: id, handle: null });
});

test("creating a sandbox provisions a real container, clones the repository and registers it", async () => {
  ({ id } = await service.create(paseo, { name: "Hello", repoUrl: "octocat/Hello-World" }));
  await idle();

  expect(await only()).toMatchObject({
    runtime: "running",
    stale: false,
    host: { status: "online" },
  });
  expect(exec("cat", "/home/paseo/Hello-World/README")).toContain("Hello World");
  expect(opened).toEqual(["/home/paseo/Hello-World"]);
  const [host] = hosts;
  expect(host?.source.key).toBe(id);
  expect(new URL(host?.connection ?? "").searchParams.get("ssl")).toBe("true");
});

test("saved credentials reach the sandbox the way each tool needs them", () => {
  expect(exec("printenv", "GITHUB_TOKEN")).toBe("ghp_itest_token");
  // Codex ignores the variable, so it is signed in instead and the key stays out of the environment.
  expect(() => exec("printenv", "CODEX_API_KEY")).toThrow();
  expect(exec("stat", "-c", "%a", "/home/paseo/.codex/auth.json")).toBe("600");
});

test("a changed credential marks the sandbox stale until it is restarted", async () => {
  await store.update((draft) => {
    draft.credentials.GITHUB_TOKEN = { value: "ghp_rotated", savedAt: new Date().toISOString() };
  });
  expect((await only())?.stale).toBe(true);

  await service.start(paseo, id);
  await idle();
  expect((await only())?.stale).toBe(false);
  expect(exec("printenv", "GITHUB_TOKEN")).toBe("ghp_rotated");
  expect(exec("cat", "/home/paseo/Hello-World/README")).toContain("Hello World");
  expect(hosts).toHaveLength(1);
});

test("stopping keeps the project and removing deletes the container, volume and host", async () => {
  await service.stop(id);
  await idle();
  expect((await only())?.runtime).toBe("stopped");
  expect(leftovers(id)).toHaveLength(2);

  await service.remove(paseo, id);
  await vi.waitFor(async () => expect((await service.list(paseo)).sandboxes).toEqual([]), {
    timeout: 60_000,
  });
  expect(leftovers(id)).toEqual([]);
  expect(hosts).toEqual([]);
});
