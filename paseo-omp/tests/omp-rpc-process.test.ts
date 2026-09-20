import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { OmpRpcRuntime } from "../server/provider/omp-rpc";
import {
  terminatePosixProcessTree,
  terminateSpawnedProcessTree,
} from "../server/provider/omp-rpc-process";
import type { OmpRpcEvent } from "../server/provider/omp-rpc-protocol";
import {
  FakeRpcChild,
  nextEvent,
  observeCommands,
  READY_FRAME,
  runtimeFor,
  TEST_RUNTIME_ENV,
  testOnWindows,
} from "./helpers/omp-rpc-harness";

describe("OMP RPC transport", () => {
  testOnWindows("terminates a live Windows process tree with taskkill", async () => {
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {
  stdio: "ignore",
  windowsHide: true,
});
process.stdout.write(String(descendant.pid) + "\\n", () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});`,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const [chunk] = (await once(leader.stdout, "data")) as [Buffer];
    const descendantPid = Number(String(chunk).trim());
    if (!leader.pid || !Number.isSafeInteger(descendantPid) || descendantPid < 1) {
      throw new Error("Windows process-tree fixture did not report valid process IDs");
    }
    const leaderClosed = once(leader, "close");

    expect(await terminateSpawnedProcessTree(leader.pid, "win32")).toBe(true);
    await leaderClosed;
    expect(() => process.kill(descendantPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  test("terminates a surviving POSIX process group after its leader exited", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    let descendantsAlive = true;
    const stopped = await terminatePosixProcessTree(
      42,
      0,
      (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") descendantsAlive = false;
        if (signal === 0 && !descendantsAlive) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
      },
      () => Promise.resolve(),
    );

    expect(stopped).toBe(true);
    expect(signals).toEqual([0, "SIGTERM", 0, "SIGKILL", 0]);
  });

  test("starts descendant cleanup once when the leader exit is observed", async () => {
    const child = new FakeRpcChild();
    const cleanup = Promise.withResolvers<boolean>();
    const cleanedPids: number[] = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree(pid) {
        cleanedPids.push(pid);
        return cleanup.promise;
      },
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    child.close(7);
    expect(cleanedPids).toEqual([child.pid]);
    const closing = session.close();
    cleanup.resolve(true);
    await closing;
    expect(cleanedPids).toEqual([child.pid]);
  });

  test("fails pending work and starts cleanup when stdout ends before process exit", async () => {
    const child = new FakeRpcChild();
    const cleanup = Promise.withResolvers<boolean>();
    const cleanedPids: number[] = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree(pid) {
        cleanedPids.push(pid);
        return cleanup.promise;
      },
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const observed: OmpRpcEvent[] = [];
    session.onEvent((event) => observed.push(event));
    const pending = session.getState();
    const failure = nextEvent((listener) => session.onEvent(listener));

    child.stdout.end();

    await expect(pending).rejects.toThrow("output channel closed");
    await expect(failure).resolves.toEqual({
      type: "process_exit",
      error: "OMP RPC output channel closed",
    });
    expect(cleanedPids).toEqual([child.pid]);
    child.close(1);
    cleanup.resolve(true);
    await session.close();
    expect(cleanedPids).toEqual([child.pid]);
    expect(observed.filter((event) => event.type === "process_exit")).toHaveLength(1);
  });

  test("starts process-tree cleanup before stdin shutdown can release the Windows tree root", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    let stdinEndedAtCleanup: boolean | undefined;
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => {
        stdinEndedAtCleanup = child.stdin.writableEnded;
        return Promise.resolve(true);
      },
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await session.close();

    expect(stdinEndedAtCleanup).toBe(false);
  });

  test("surfaces unverified process-tree cleanup", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(false),
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.close()).rejects.toThrow("cleanup failed");
  });
  test("treats uncertain injected process-tree cleanup as unsuccessful", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve("uncertain"),
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.close()).rejects.toThrow("cleanup failed");
  });

  test("never reports cleanup success without invoking process-tree termination", async () => {
    const child = new FakeRpcChild();
    child.stdin.removeAllListeners("finish");
    let cleanupCalls = 0;
    observeCommands(child, (command) => {
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { protocolVersion: 2 },
      });
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => {
        cleanupCalls += 1;
        return Promise.resolve(true);
      },
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.close()).rejects.toThrow("did not close after tree cleanup");
    expect(cleanupCalls).toBe(1);
  });

  if (process.platform !== "win32") {
    test("leader exit fails a prompt and permits recovery while a descendant holds stdio", async () => {
      const script = `
        const { spawn } = require("node:child_process");
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: false,
          stdio: ["ignore", "inherit", "inherit"],
        });
        descendant.unref();
        process.stdout.write(JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864,
        }) + "\\n");
        let input = "";
        process.stdin.on("data", chunk => {
          input += String(chunk);
          while (true) {
            const newline = input.indexOf("\\n");
            if (newline < 0) return;
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            if (!line) continue;
            const command = JSON.parse(line);
            if (command.type === "negotiate_protocol") {
              process.stdout.write(JSON.stringify({
                type: "response",
                id: command.id,
                command: "negotiate_protocol",
                success: true,
                data: { protocolVersion: 2 },
              }) + "\\n");
              continue;
            }
            if (command.type === "prompt") process.exit(7);
            if (command.type !== "get_state") continue;
            process.stdout.write(JSON.stringify({ type: "notice", level: "info", message: String(descendant.pid) }) + "\\n");
            process.stdout.write(JSON.stringify({
              type: "response",
              id: command.id,
              success: true,
              data: { model: null, isStreaming: false, isCompacting: false, sessionId: "tree" },
            }) + "\\n");
          }
        });
        process.stdin.on("end", () => process.exit(0));
      `;
      let leader: ChildProcessWithoutNullStreams | null = null;
      const runtime = new OmpRpcRuntime({
        spawnProcess(request) {
          leader = spawn(process.execPath, ["-e", script], {
            cwd: request.cwd,
            env: request.env,
            detached: request.detached,
            stdio: ["pipe", "pipe", "pipe"],
          });
          return leader;
        },
        environment: TEST_RUNTIME_ENV,
      });
      const procfsAvailable = (() => {
        try {
          readFileSync("/proc/self/stat", "utf8");
          return true;
        } catch {
          return false;
        }
      })();
      const descendantIsExecuting = (pid: number) => {
        try {
          if (procfsAvailable) {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const stateOffset = stat.lastIndexOf(")") + 2;
            return stat[stateOffset] !== "Z";
          }
          process.kill(pid, 0);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ESRCH") return false;
          throw error;
        }
      };
      const waitUntilStopped = async (pid: number) => {
        const deadline = Date.now() + 2_000;
        while (descendantIsExecuting(pid) && Date.now() < deadline) await sleep(10);
        return !descendantIsExecuting(pid);
      };
      const descendantPids: number[] = [];
      try {
        const session = await runtime.startSession({ cwd: process.cwd(), mode: "full" });
        const descendantPidEvent = nextEvent((listener) => session.onEvent(listener));
        await session.getState();
        const notice = await descendantPidEvent;
        if (notice.type !== "notice") throw new Error("Expected descendant PID notice");
        descendantPids.push(Number(notice.message));
        if (!leader) throw new Error("Expected OMP leader process");
        const leaderExit = once(leader, "exit");
        const promptOutcome = session.prompt("work").then(
          () => "resolved",
          (error) => (error instanceof Error ? error.message : String(error)),
        );
        expect(
          await Promise.race([leaderExit.then(() => true), sleep(2_000).then(() => false)]),
        ).toBe(true);
        expect(await Promise.race([promptOutcome, sleep(2_000).then(() => "timed out")])).toContain(
          "exited",
        );
        await session.close();
        expect(await waitUntilStopped(descendantPids[0] as number)).toBe(true);

        const recovered = await runtime.startSession({
          cwd: process.cwd(),
          mode: "full",
          resumeSessionId: "tree-session",
        });
        const recoveredPidEvent = nextEvent((listener) => recovered.onEvent(listener));
        await recovered.getState();
        const recoveredNotice = await recoveredPidEvent;
        if (recoveredNotice.type !== "notice") throw new Error("Expected recovered descendant PID");
        descendantPids.push(Number(recoveredNotice.message));
        await recovered.close();
        expect(await waitUntilStopped(descendantPids[1] as number)).toBe(true);
      } finally {
        for (const pid of descendantPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    });
  }

  test("fails the session once when child stdin closes with EPIPE", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));

    child.stdin.destroy(new Error("EPIPE"));

    const event = await failure;
    expect(event.type).toBe("process_exit");
    await expect(session.steer("after-close")).rejects.toThrow();
    await session.close();
  });
});
