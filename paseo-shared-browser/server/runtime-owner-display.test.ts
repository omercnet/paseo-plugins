import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeOwner } from "./runtime-owner";
import { RuntimeLostError } from "./runtime-protocol";
import { PrivateDisplayError } from "./virtual-display";

const fake = vi.hoisted(() => ({
  display: vi.fn(),
  runtime: vi.fn(),
  launch: vi.fn(),
  shutdown: vi.fn(),
  assertAvailable: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./virtual-display", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./virtual-display")>()),
  createPrivateVirtualDisplay: fake.display,
}));
vi.mock("./runtime-path", () => ({
  resolveBrowserRuntimeRoot: () => "/tmp/owned-runtime-fixture",
}));
vi.mock("./agent-browser-runtime", () => ({
  AgentBrowserRuntime: class {
    launch = fake.launch;
    shutdown = fake.shutdown;
    identity = async () => ({ userAgent: "Fixture" });
    constructor(options: unknown) {
      fake.runtime(options);
    }
  },
}));
afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", undefined);
  vi.clearAllMocks();
  fake.assertAvailable.mockReset();
  fake.launch.mockResolvedValue(undefined);
  fake.shutdown.mockResolvedValue(undefined);
  fake.stop.mockResolvedValue(undefined);
  fake.display.mockResolvedValue({
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
    assertAvailable: fake.assertAvailable,
    stop: fake.stop,
  });
});

it("supplies private display environment only to opted-in hidden runtime creation", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
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
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  await (await createRuntimeOwner({ headed: true })).create("headed-fixture");
  expect(fake.display).not.toHaveBeenCalled();
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: true });
  expect(fake.runtime.mock.calls[0]![0]).not.toHaveProperty("launchEnvironment");
  fake.display.mockResolvedValue(null);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const owner = await createRuntimeOwner();
    const absent = await owner.create("absent-fixture");
    expect(fake.runtime.mock.calls[1]![0]).toMatchObject({ headed: false });
    await expect(owner.request(absent, "identity", null)).resolves.toMatchObject({
      displayNotice: "Private display unavailable: Xvfb was not found.",
    });
  } finally {
    warning.mockRestore();
  }
});

it("falls back only before Chromium construction and reports a bounded secret-free notice", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [failure, notice] of [
      [
        new PrivateDisplayError("Private browser display ended before readiness"),
        "Private display unavailable: Private browser display ended before readiness.",
      ],
      [
        new Error("EACCES /home/user/.Xauthority-secret-cookie"),
        "Private display unavailable: unexpected startup failure.",
      ],
    ] as const) {
      fake.display.mockRejectedValueOnce(failure);
      const owner = await createRuntimeOwner();
      const runtime = await owner.create("startup-fallback-fixture");
      expect(fake.runtime.mock.calls.at(-1)![0]).toMatchObject({ headed: false });
      expect(fake.runtime.mock.calls.at(-1)![0]).not.toHaveProperty("launchEnvironment");
      const identity = await owner.request(runtime, "identity", null);
      expect(identity).toMatchObject({ displayNotice: notice });
      expect(JSON.stringify(identity)).not.toContain("secret");
      expect(warning).toHaveBeenLastCalledWith(`[shared-browser] ${notice} Using headless mode.`);
    }
  } finally {
    warning.mockRestore();
  }
});

it("cleans the private display after launch failure and even failing browser shutdown", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  fake.launch.mockRejectedValue(new Error("fixture launch failure"));
  fake.shutdown.mockRejectedValue(new Error("fixture shutdown failure"));
  await expect((await createRuntimeOwner()).create("failure-fixture")).rejects.toThrow();
  expect(fake.stop).toHaveBeenCalledTimes(1);
});

it("refuses runtime requests after private display loss", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  const owner = await createRuntimeOwner();
  const runtime = await owner.create("loss-fixture");
  fake.assertAvailable.mockImplementation(() => {
    throw new RuntimeLostError("Private display ended");
  });
  await expect(owner.request(runtime, "state", null)).rejects.toBeInstanceOf(RuntimeLostError);
  await owner.stop(runtime);
  expect(fake.stop).toHaveBeenCalledTimes(1);
});

it("stays headless by default and for any environment value other than 1", async () => {
  const owner = await createRuntimeOwner();
  for (const value of [undefined, "", "0", "true", "yes"]) {
    vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", value);
    await owner.create("default-fixture");
  }
  expect(fake.display).not.toHaveBeenCalled();
  for (const call of fake.runtime.mock.calls) {
    expect(call[0]).toMatchObject({ headed: false });
    expect(call[0]).not.toHaveProperty("launchEnvironment");
  }
});

it("reads the environment at each runtime creation and lets an explicit option override it", async () => {
  const owner = await createRuntimeOwner();
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  await owner.create("env-opt-in");
  expect(fake.display).toHaveBeenCalledTimes(1);
  await (await createRuntimeOwner({ virtualDisplay: false })).create("option-false");
  expect(fake.display).toHaveBeenCalledTimes(1);
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", undefined);
  await (await createRuntimeOwner({ virtualDisplay: true })).create("option-true");
  expect(fake.display).toHaveBeenCalledTimes(2);
});
