import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createSandboxService, type SandboxService } from "../../server/service";
import { Store } from "../../server/store";
import { FakeHosts } from "../support";
import { docker, leftovers, provider, requireDocker } from "./support";

/** The controller's host registry is faked; everything on the sandbox side is real Docker. */
const hosts = new FakeHosts();
let store: Store;
let service: SandboxService;
let id = "";

async function only() {
  const [sandbox] = (await service.list(hosts)).sandboxes;
  return sandbox;
}

function idle() {
  return vi.waitFor(
    async () => {
      const sandbox = await only();
      expect(sandbox?.error).toBeNull();
      expect(sandbox?.busy).toBeNull();
    },
    { timeout: 15 * 60_000, interval: 1000 },
  );
}

function inside(...argv: string[]) {
  return docker("exec", "--user", "paseo", `paseo-sandbox-${id}`, ...argv);
}

async function saveCredential(name: string, value: string) {
  await store.update((draft) => {
    draft.credentials[name] = { value, savedAt: new Date().toISOString() };
  });
}

beforeAll(async () => {
  await requireDocker();
  store = new Store(join(await mkdtemp(join(tmpdir(), "sandbox-e2e-")), "state.json"));
  service = createSandboxService(provider, store);
  await saveCredential("GITHUB_TOKEN", "ghp_itest_token");
  await saveCredential("CODEX_API_KEY", "sk-itest-codex-key");
});

afterAll(async () => {
  if (id) await provider.destroy({ key: id, handle: null });
});

test("creating a sandbox provisions a real container, clones the project and registers it", async () => {
  ({ id } = await service.create(hosts, { name: "Hello", repoUrl: "octocat/Hello-World" }));
  await idle();

  expect(await only()).toMatchObject({
    runtime: "running",
    stale: false,
    host: { status: "online" },
  });
  expect(inside("cat", "/home/paseo/Hello-World/README")).toContain("Hello World");
  expect(hosts.opened).toEqual(["/home/paseo/Hello-World"]);
  expect(hosts.rows[0]?.source.key).toBe(id);
});

test("saved credentials reach the sandbox the way each tool needs them", () => {
  expect(inside("printenv", "GITHUB_TOKEN")).toBe("ghp_itest_token");
  // Codex ignores the variable, so it is signed in instead and the key stays out of the environment.
  expect(() => inside("printenv", "CODEX_API_KEY")).toThrow();
  expect(inside("stat", "-c", "%a", "/home/paseo/.codex/auth.json")).toBe("600");
});

test("a changed credential marks the sandbox stale until it is restarted", async () => {
  await saveCredential("GITHUB_TOKEN", "ghp_rotated");
  expect((await only())?.stale).toBe(true);

  await service.start(hosts, id);
  await idle();

  expect((await only())?.stale).toBe(false);
  expect(inside("printenv", "GITHUB_TOKEN")).toBe("ghp_rotated");
  expect(inside("cat", "/home/paseo/Hello-World/README")).toContain("Hello World");
  expect(hosts.rows).toHaveLength(1);
});

test("stopping keeps the project and removing deletes the container, volume and host", async () => {
  await service.stop(id);
  await idle();
  expect((await only())?.runtime).toBe("stopped");
  expect(leftovers(id)).toHaveLength(2);

  await service.remove(hosts, id);
  await vi.waitFor(async () => expect((await service.list(hosts)).sandboxes).toEqual([]), {
    timeout: 60_000,
  });
  expect(leftovers(id)).toEqual([]);
  expect(hosts.rows).toEqual([]);
});
