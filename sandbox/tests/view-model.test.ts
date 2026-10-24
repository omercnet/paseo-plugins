import { describe, expect, test } from "vitest";
import {
  describeSandbox,
  hasModelCredential,
  needsRestart,
  repositoryName,
} from "../client/view-model";
import type { Sandbox } from "../shared/sandbox";

const base: Sandbox = {
  id: "a",
  name: "n",
  repoUrl: "https://github.com/a/b",
  createdAt: "2026-01-01",
  runtime: "running",
  host: { status: "online", serverId: "srv", error: null },
  stale: false,
  busy: null,
  error: null,
};
const say = (patch: Partial<Sandbox>) => describeSandbox({ ...base, ...patch });

describe("describeSandbox", () => {
  test("work in flight outranks a previous failure, which outranks the state", () => {
    expect(say({ busy: "Creating", error: "boom", stale: true })).toBe("Creating...");
    expect(say({ error: "boom", stale: true })).toBe("Failed: boom");
  });

  test("tells a person what to do next", () => {
    expect(say({ runtime: "stopped" })).toContain("data is kept");
    expect(say({ runtime: "missing" })).toContain("Start it");
    expect(say({ stale: true })).toContain("Restart");
    expect(say({ host: { status: "error", serverId: null, error: null } })).toContain(
      "cannot connect",
    );
    expect(say({})).toContain("in the sidebar");
  });
});

describe("a connection the daemon cannot make", () => {
  const broken = (error: string | null) =>
    ({ host: { status: "error", serverId: null, error }, stale: true }) as const;

  test("shows the daemon's own reason, and outranks stale credentials", () => {
    expect(say(broken("Authentication failed"))).toContain("Authentication failed");
    expect(say(broken(null))).toContain("Restart it to retry");
  });

  test("offers Restart for errors, disabled hosts and stale credentials, never for a stopped sandbox", () => {
    expect(needsRestart({ ...base, host: { status: "error", serverId: null, error: "x" } })).toBe(
      true,
    );
    expect(
      needsRestart({ ...base, host: { status: "disabled", serverId: "srv", error: null } }),
    ).toBe(true);
    expect(needsRestart({ ...base, stale: true })).toBe(true);
    expect(needsRestart(base)).toBe(false);
    expect(needsRestart({ ...base, runtime: "stopped", stale: true })).toBe(false);
  });
});

test("repositoryName and hasModelCredential", () => {
  expect(repositoryName("https://github.com/a/b.git/")).toBe("b");
  expect(repositoryName("octocat/Hello-World")).toBe("Hello-World");
  const credential = { name: "X", label: "X", savedAt: "", expiresAt: null };
  expect(hasModelCredential([{ ...credential, kind: "git" }])).toBe(false);
  expect(hasModelCredential([{ ...credential, kind: "model" }])).toBe(true);
  expect(hasModelCredential(undefined)).toBe(false);
});
