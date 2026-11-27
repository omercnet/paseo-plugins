import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OmpRpcProcess } from "../server/omp-accounts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: Record<string, unknown>[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      const frame = JSON.parse(String(chunk));
      this.writes.push(frame);
      this.stdout.write(
        `${JSON.stringify({ type: "response", id: frame.id, success: true, data: {} })}\n`,
      );
    });
  }

  kill() {
    this.emit("close", 0);
    return true;
  }
  asChildProcess() {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const { spawn } = await import("node:child_process");
const spawning = vi.mocked(spawn);

beforeEach(() => {
  for (const name of [
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CODING_AGENT_DIR",
    "PASEO_OMP_AGENT_DIR",
    "OMP_AGENT_DIR",
    "PI_CONFIG_DIR",
  ])
    vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// Test only cancellation and rejected-frame replay. Model startup is covered by real child fixtures.
describe.skipIf(process.platform === "win32")("OmpRpcProcess lifecycle", () => {
  test("close immediately rejects a queued waiter", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawning.mockReturnValue(child.asChildProcess());
    const helper = new OmpRpcProcess({ executable: "unused", env: {} });
    const waiting = helper.request({ type: "login", providerId: "anthropic" }, 60_000);
    helper.close();
    await expect(waiting).rejects.toThrow("omp is closing");
    await vi.runAllTimersAsync();
    expect(child.writes).toEqual([]);
  });

  test("a timed-out frame is not sent after retry readiness", async () => {
    vi.useFakeTimers();
    const initial = new FakeChild();
    const retry = new FakeChild();
    spawning
      .mockReturnValueOnce(initial.asChildProcess())
      .mockReturnValueOnce(retry.asChildProcess());
    const helper = new OmpRpcProcess({ executable: "unused", env: {} });
    const request = helper.request({ type: "logout" }, 10);
    const timedOut = expect(request).rejects.toThrow("did not answer logout in time");
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    initial.stderr.write("No default model selected.");
    initial.emit("close", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawning).toHaveBeenCalledTimes(2);
    retry.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
    await expect(helper.request({ type: "get_login_providers" })).resolves.toEqual({});
    helper.close();
    expect(retry.writes.map((frame) => frame.type)).toEqual(["get_login_providers"]);
  });
});
