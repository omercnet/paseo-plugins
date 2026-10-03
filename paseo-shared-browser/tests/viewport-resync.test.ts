import { describe, expect, it } from "vitest";
import { AgentBrowserRuntime, jpegDimensions } from "../server/agent-browser-runtime";

function jpeg(width: number, height: number): string {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ]);
  const comment = Buffer.from([0xff, 0xfe, 0, 4, 0x41, 0x42]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    comment,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]).toString("base64");
}

function fakeRuntime(heights: number[], viewport = { width: 1280, height: 800 }) {
  const calls: string[] = [];
  const page = {
    async send(method: string) {
      calls.push(method);
      if (method === "Page.captureScreenshot") {
        const height = heights.shift() ?? 800;
        return { data: jpeg(viewport.width, height) };
      }
      return {};
    },
  };
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/bin/true",
    executablePath: "/bin/true",
    profilePath: "/tmp/p",
    ipcDirectory: "/tmp/i",
    session: "fake",
  });
  Object.assign(runtime, {
    page,
    connection: { isOpen: true },
    viewport: { ...viewport, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  return { runtime, calls };
}

describe("jpegDimensions", () => {
  it("reads the frame size past other segments", () => {
    expect(jpegDimensions(jpeg(1280, 633))).toEqual({ width: 1280, height: 633 });
  });
  it("returns null for non-JPEG data", () => {
    expect(jpegDimensions(Buffer.from("not a jpeg").toString("base64"))).toBeNull();
  });
});

describe("fallback frame viewport resync", () => {
  it("returns the first capture untouched when dimensions agree", async () => {
    const { runtime, calls } = fakeRuntime([800]);
    expect((await runtime.frame(1_000_000, 65, 1)).height).toBe(800);
    expect(calls).not.toContain("Emulation.setDeviceMetricsOverride");
  });

  it("re-applies emulation and recaptures once when the JPEG height drifts", async () => {
    const { runtime, calls } = fakeRuntime([633, 800]);
    const frame = await runtime.frame(1_000_000, 65, 1);
    expect(frame).toMatchObject({ width: 1280, height: 800 });
    expect(calls.filter((call) => call === "Emulation.setDeviceMetricsOverride")).toHaveLength(1);
    expect(calls.filter((call) => call === "Page.captureScreenshot")).toHaveLength(2);
  });

  it("fails instead of reporting stale metadata when the resync does not help", async () => {
    const { runtime, calls } = fakeRuntime([633, 577, 800]);
    await expect(runtime.frame(1_000_000, 65, 1)).rejects.toThrow("1280x577 JPEG");
    expect(calls.filter((call) => call === "Page.captureScreenshot")).toHaveLength(2);
  });
});
