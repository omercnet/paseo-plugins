import { describe, expect, test } from "vitest";
import { describeSandbox, hasModelCredential, repositoryName } from "../client/view-model";
import type { Sandbox } from "../shared/sandbox";

const base: Sandbox = {
  id: "a",
  name: "n",
  repoUrl: "https://github.com/a/b",
  createdAt: "2026-01-01",
  runtime: "running",
  host: { status: "online", serverId: "srv" },
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
    expect(say({ host: { status: "error", serverId: null } })).toContain("cannot connect");
    expect(say({})).toContain("in the sidebar");
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
