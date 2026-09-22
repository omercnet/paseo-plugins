import { describe, expect, test } from "vitest";
import {
  createAutoOpenClaimHandler,
  createFileAutoOpenStore,
  createMemoryAutoOpenStore,
} from "../server/auto-open";
import { claimUnclaimedWorkspaces } from "../shared/auto-open";

describe("claimUnclaimedWorkspaces", () => {
  test("returns only candidates that were never opened", () => {
    const opened = new Set(["ws-1", "ws-2"]);
    expect(claimUnclaimedWorkspaces(opened, ["ws-1", "ws-3", "ws-2", "ws-4"])).toEqual([
      "ws-3",
      "ws-4",
    ]);
  });

  test("removes duplicate candidates within one batch", () => {
    expect(claimUnclaimedWorkspaces(new Set(), ["ws-1", "ws-1", "ws-2", "ws-1"])).toEqual([
      "ws-1",
      "ws-2",
    ]);
  });

  test("returns an empty list when everything was opened", () => {
    const opened = new Set(["ws-1"]);
    expect(claimUnclaimedWorkspaces(opened, ["ws-1"])).toEqual([]);
  });
});

describe("createAutoOpenClaimHandler", () => {
  test("claims and persists each workspace exactly once", async () => {
    const handler = createAutoOpenClaimHandler(createMemoryAutoOpenStore());

    const first = await handler({ workspaceIds: ["ws-1", "ws-2"] });
    const second = await handler({ workspaceIds: ["ws-1", "ws-2", "ws-3"] });

    expect(first.claimed).toEqual(["ws-1", "ws-2"]);
    expect(second.claimed).toEqual(["ws-3"]);
  });

  test("returns nothing new for a repeated workspace after a restart", async () => {
    const store = createMemoryAutoOpenStore();
    const firstHandler = createAutoOpenClaimHandler(store);
    await firstHandler({ workspaceIds: ["ws-1"] });

    const secondHandler = createAutoOpenClaimHandler(store);
    const result = await secondHandler({ workspaceIds: ["ws-1"] });

    expect(result.claimed).toEqual([]);
  });

  test("serializes concurrent claims so no workspace opens twice", async () => {
    const store = createMemoryAutoOpenStore();
    const handler = createAutoOpenClaimHandler(store);

    const [first, second] = await Promise.all([
      handler({ workspaceIds: ["ws-1"] }),
      handler({ workspaceIds: ["ws-1"] }),
    ]);

    const totalClaims = first.claimed.length + second.claimed.length;
    expect(totalClaims).toBe(1);
  });
});

describe("createFileAutoOpenStore", () => {
  test("loads an empty set when the file does not exist", async () => {
    const store = createFileAutoOpenStore("/nonexistent/agent-crew/auto-open.json");
    expect(await store.load()).toEqual(new Set());
  });

  test("persists and reloads claimed workspaces", async () => {
    const directory = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/agent-crew-"));
    const filePath = `${directory}/auto-open.json`;
    const store = createFileAutoOpenStore(filePath);

    await store.persist(new Set(["ws-1", "ws-2"]));
    expect(await store.load()).toEqual(new Set(["ws-1", "ws-2"]));

    await store.persist(new Set(["ws-1"]));
    expect(await store.load()).toEqual(new Set(["ws-1"]));

    await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true }));
  });

  test("recovers from a corrupted store file", async () => {
    const directory = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/agent-crew-"));
    const filePath = `${directory}/auto-open.json`;
    await import("node:fs/promises").then((fs) => fs.writeFile(filePath, "not json", "utf8"));

    const store = createFileAutoOpenStore(filePath);
    expect(await store.load()).toEqual(new Set());

    await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true }));
  });
});
