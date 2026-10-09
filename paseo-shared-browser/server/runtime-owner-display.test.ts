import { beforeEach, expect, it, vi } from "vitest";
import { createRuntimeOwner } from "./runtime-owner";

const fake = vi.hoisted(() => ({
  display: vi.fn(),
  runtime: vi.fn(),
  launch: vi.fn(),
  identity: vi.fn(),
  shutdown: vi.fn(),
  assertAvailable: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./virtual-display", () => ({ createPrivateVirtualDisplay: fake.display }));
vi.mock("./runtime-path", () => ({
  resolveBrowserRuntimeRoot: () => "/tmp/owned-runtime-fixture",
}));
vi.mock("./agent-browser-runtime", () => ({
  AgentBrowserRuntime: class {
    launch = fake.launch;
    identity = fake.identity;
    shutdown = fake.shutdown;
    constructor(options: unknown) {
      fake.runtime(options);
    }
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  fake.launch.mockResolvedValue(undefined);
  fake.identity.mockResolvedValue({ targetId: "owned-page" });
  fake.shutdown.mockResolvedValue(undefined);
  fake.stop.mockResolvedValue(undefined);
  fake.display.mockResolvedValue({
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
    assertAvailable: fake.assertAvailable,
    stop: fake.stop,
  });
});

it("supplies private display environment only to hidden runtime creation", async () => {
  const owner = await createRuntimeOwner();
  const runtime = await owner.create("workspace-fixture");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({
    headed: true,
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
  });
  await owner.stop(runtime);
  expect(fake.shutdown).toHaveBeenCalledTimes(1);
  expect(fake.stop).toHaveBeenCalledTimes(1);
});

it("keeps explicit headed mode and unavailable-display headless behavior unchanged", async () => {
  await (await createRuntimeOwner({ headed: true })).create("headed-fixture");
  expect(fake.display).not.toHaveBeenCalled();
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: true });
  expect(fake.runtime.mock.calls[0]![0]).not.toHaveProperty("launchEnvironment");
  fake.display.mockResolvedValue(null);
  await (await createRuntimeOwner()).create("absent-fixture");
  expect(fake.runtime.mock.calls[1]![0]).toMatchObject({ headed: false });
});

it("falls back only before Chromium construction when optional display startup fails", async () => {
  fake.display.mockRejectedValue(new Error("fixture private startup failure"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await (await createRuntimeOwner()).create("startup-fallback-fixture");
    expect(fake.runtime).toHaveBeenCalledTimes(1);
    expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: false });
    expect(fake.runtime.mock.calls[0]![0]).not.toHaveProperty("launchEnvironment");
    expect(warning).toHaveBeenCalledWith(
      "[shared-browser] Private display unavailable; using existing headless mode.",
    );
  } finally {
    warning.mockRestore();
  }
});

it("cleans the private display after launch failure and even failing browser shutdown", async () => {
  fake.launch.mockRejectedValue(new Error("fixture launch failure"));
  fake.shutdown.mockRejectedValue(new Error("fixture shutdown failure"));
  await expect((await createRuntimeOwner()).create("failure-fixture")).rejects.toThrow();
  expect(fake.stop).toHaveBeenCalledTimes(1);
});

it("refuses runtime requests after private display loss", async () => {
  const owner = await createRuntimeOwner();
  const runtime = await owner.create("loss-fixture");
  fake.assertAvailable.mockImplementation(() => {
    throw new Error("Private display ended");
  });
  await expect(owner.request(runtime, "state", null)).rejects.toThrow("ended");
  await owner.stop(runtime);
  expect(fake.stop).toHaveBeenCalledTimes(1);
});
