import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test } from "vitest";
import { resolveContextModeBinary } from "../server/binary";
import { createContextModeHandlers } from "../server/handlers";
import {
  CONTEXT_MODE_TOOL_TIMEOUT_MS,
  callContextModeTool,
  inspectContextMode,
  ProcessFailure,
} from "../server/mcp-process";
import {
  type ContextModeSettings,
  ContextModeSettingsSchema,
  type contextModeSettings,
} from "../shared";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function executable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-context-mode-"));
  temporaryDirectories.push(directory);
  const path = join(directory, process.platform === "win32" ? "context-mode.cjs" : "context-mode");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}

function launch(program: string) {
  return process.platform === "win32"
    ? { program: process.execPath, args: [program] }
    : { program, args: [] };
}

function settingsHandle(
  values: ContextModeSettings,
): PluginSettings<typeof contextModeSettings.schema> {
  return {
    read: async () => ({ status: "ready", revision: "test", values }),
    subscribe: () => () => {},
  };
}

const fakeMcpSource = `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "context-mode", version: "2.0.5" } } }));
  }
  if (request.method === "tools/list") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ctx_doctor" }, { name: "ctx_stats" }] } }));
  }
  if (request.method === "tools/call") {
    const text = request.params.name === "ctx_stats" ? "17.4 MB kept out · 96%" : "[x] FTS5 ready\\n[x] hooks ready";
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } }));
  }
});
`;

describe("external binary resolution", () => {
  test("prefers an executable absolute setting before PATH", async () => {
    const settings = ContextModeSettingsSchema.parse({ binaryPath: "/opt/context-mode" });
    const checked: string[] = [];
    const result = await resolveContextModeBinary(settings, {
      env: { PATH: "/usr/bin" },
      platform: "linux",
      canExecute: async (path) => {
        checked.push(path);
        return path === "/opt/context-mode";
      },
    });
    expect(result).toMatchObject({
      state: "found",
      source: "settings",
      launch: { program: "/opt/context-mode", args: [] },
    });
    expect(checked).toEqual(["/opt/context-mode"]);
  });
  test("uses filesystem-backed executable checks for a real binary path", async () => {
    const executablePath = await realpath(process.execPath);
    const settings = ContextModeSettingsSchema.parse({ binaryPath: executablePath });
    const result = await resolveContextModeBinary(settings, { env: { PATH: "" } });

    expect(result).toMatchObject({
      state: "found",
      path: executablePath,
      source: "settings",
      launch: { program: executablePath, args: [] },
    });
  });

  test("reports relative configured paths and PATH fallbacks", async () => {
    const relative = {
      ...ContextModeSettingsSchema.parse({}),
      binaryPath: "bin/context-mode",
    } as ContextModeSettings;
    await expect(resolveContextModeBinary(relative)).resolves.toMatchObject({
      state: "missing",
      code: "not-installed",
      message: expect.stringContaining("not absolute"),
    });

    const found = await resolveContextModeBinary(
      ContextModeSettingsSchema.parse({ binaryPath: "/missing/context-mode" }),
      {
        env: { PATH: "/first:/second" },
        platform: "linux",
        canExecute: async (path) => path === "/second/context-mode",
      },
    );

    expect(found).toEqual({
      state: "found",
      path: "/second/context-mode",
      source: "path",
      launch: { program: "/second/context-mode", args: [] },
    });
  });

  test.each(["", ".CMD", ".BAT"])(
    "resolves a Windows npm %s shim through node and its CLI module",
    async (extension) => {
      const shim = `C:\\npm\\context-mode${extension}`;
      const modulePath = "C:\\npm\\node_modules\\context-mode\\cli.bundle.mjs";
      const settings = ContextModeSettingsSchema.parse({ binaryMode: "automatic" });
      const result = await resolveContextModeBinary(settings, {
        platform: "win32",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        env: { PATH: "C:\\npm", PATHEXT: ".CMD;.BAT" },
        canExecute: async (path) => path === shim,
        isFile: async (path) => path === modulePath,
      });
      expect(result).toEqual({
        state: "found",
        path: shim,
        source: "path",
        launch: {
          program: "C:\\Program Files\\nodejs\\node.exe",
          args: [modulePath],
        },
      });
    },
  );

  test("rejects a Windows command shim when its CLI module cannot be resolved", async () => {
    const settings = ContextModeSettingsSchema.parse({ binaryMode: "automatic" });
    const result = await resolveContextModeBinary(settings, {
      platform: "win32",
      env: { PATH: "C:\\npm", PATHEXT: ".CMD" },
      canExecute: async (path) => path.endsWith("context-mode.CMD"),
      isFile: async () => false,
      bundledCliPath: () => null,
    });
    expect(result).toMatchObject({ state: "missing" });
    if (result.state === "missing")
      expect(result.message).toContain("could not be safely resolved");
  });
  test.each([".exe", ".js", ".mjs"])(
    "returns direct or node launch descriptors for Windows %s shims",
    async (extension) => {
      const shim = `C:\\npm\\context-mode${extension}`;
      const settings = ContextModeSettingsSchema.parse({
        binaryMode: "path",
        binaryPath: shim,
      });
      const result = await resolveContextModeBinary(settings, {
        platform: "win32",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        canExecute: async (path) => path === shim,
        isFile: async () => false,
      });

      expect(result).toEqual(
        extension === ".exe"
          ? {
              state: "found",
              path: shim,
              source: "settings",
              launch: { program: shim, args: [] },
            }
          : {
              state: "found",
              path: shim,
              source: "settings",
              launch: {
                program: "C:\\Program Files\\nodejs\\node.exe",
                args: [shim],
              },
            },
      );
    },
  );

  test("uses the bundled runtime when no external executable is available", async () => {
    const settings = ContextModeSettingsSchema.parse({ binaryMode: "automatic" });
    const result = await resolveContextModeBinary(settings, {
      env: { PATH: "" },
      nodePath: "/usr/bin/node",
      canExecute: async () => false,
      isFile: async (path) => path === "/plugin/node_modules/context-mode/cli.bundle.mjs",
      bundledCliPath: () => "/plugin/node_modules/context-mode/cli.bundle.mjs",
    });
    expect(result).toEqual({
      state: "found",
      path: "/plugin/node_modules/context-mode/cli.bundle.mjs",
      source: "bundled",
      launch: {
        program: "/usr/bin/node",
        args: ["/plugin/node_modules/context-mode/cli.bundle.mjs"],
      },
    });
  });
});

describe("bounded Context Mode process", () => {
  test("reports version and preserves upstream doctor and stats text", async () => {
    const binary = await executable(fakeMcpSource);
    await expect(inspectContextMode(launch(binary))).resolves.toEqual({
      version: "2.0.5",
      tools: ["ctx_doctor", "ctx_stats"],
    });
    await expect(callContextModeTool(launch(binary), "ctx_doctor")).resolves.toBe(
      "[x] FTS5 ready\n[x] hooks ready",
    );
    await expect(callContextModeTool(launch(binary), "ctx_stats")).resolves.toBe(
      "17.4 MB kept out · 96%",
    );
  });

  test("rejects a failed initialize response with the upstream message", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boot failed" } }));
});
`);
    await expect(inspectContextMode(launch(binary))).rejects.toMatchObject({
      code: "protocol-error",
      message: "boot failed",
    });
  });

  test("marks unsupported tool errors separately from command failures", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "2.0.5" } } }));
  if (request.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "tool not found" } }));
});
`);
    await expect(callContextModeTool(launch(binary), "ctx_doctor")).rejects.toMatchObject({
      code: "unsupported",
      message: "tool not found",
    });
  });

  test("budgets long-running Context Mode tools beyond upstream fetch timeouts", () => {
    expect(CONTEXT_MODE_TOOL_TIMEOUT_MS.ctx_fetch_and_index).toBeGreaterThan(30_000);
    expect(CONTEXT_MODE_TOOL_TIMEOUT_MS.ctx_index).toBeGreaterThan(30_000);
    expect(CONTEXT_MODE_TOOL_TIMEOUT_MS.ctx_purge).toBeGreaterThan(30_000);
  });

  test("allows Context Mode to exit cleanly after a successful exchange", async () => {
    const signals: NodeJS.Signals[] = [];
    const stdout = new PassThrough();
    const emitter = new EventEmitter();
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()) as { id?: number };
        callback();
        if (request.id === 1) {
          queueMicrotask(() =>
            stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "1.0.169" } } })}\n`,
            ),
          );
        } else if (request.id === 2) {
          queueMicrotask(() =>
            stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n`),
          );
        }
      },
    });
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr: new PassThrough(),
      killed: false,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        if (signal === "SIGTERM") {
          queueMicrotask(() => emitter.emit("exit", 0, signal));
        }
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const spawnProcess = (() => child) as unknown as typeof spawn;

    await expect(
      inspectContextMode(launch("ignored"), { spawnProcess, terminationGraceMs: 20 }),
    ).resolves.toEqual({ version: "1.0.169", tools: [] });
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("terminates commands that time out", async () => {
    const binary = await executable("process.stdin.resume();");
    await expect(inspectContextMode(launch(binary), { timeoutMs: 30 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  test("terminates commands that exceed the output cap", async () => {
    const binary = await executable(
      'process.stdout.write("x".repeat(4096)); process.stdin.resume();',
    );
    await expect(inspectContextMode(launch(binary), { outputLimit: 128 })).rejects.toMatchObject({
      code: "output-limit",
    });
  });

  test("turns a closed protocol input into a typed failure", async () => {
    const brokenPipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const signals: string[] = [];
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(brokenPipe);
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        this.killed = true;
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const spawnProcess = (() => child) as unknown as typeof spawn;
    await expect(
      inspectContextMode(launch("ignored"), {
        spawnProcess,
        timeoutMs: 1_000,
        terminationGraceMs: 1,
      }),
    ).rejects.toMatchObject({
      code: "protocol-error",
      message: expect.stringContaining("broken pipe"),
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("uses structured content when text content is empty", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "2.0.5" } } }));
  if (request.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "" }], structuredContent: { savedBytes: 17825792 } } }));
});
`);
    await expect(callContextModeTool(launch(binary), "ctx_stats")).resolves.toBe(
      '{\n  "savedBytes": 17825792\n}',
    );
  });

  test("maps MCP tool isError results to command failures", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "2.0.5" } } }));
  if (request.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "upstream failure" }], isError: true } }));
});
`);
    await expect(callContextModeTool(launch(binary), "ctx_doctor")).rejects.toMatchObject({
      code: "command-failed",
      message: "upstream failure",
    });
  });
});

describe("RPC behavior", () => {
  test("returns a typed not-installed state instead of throwing", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "missing",
        code: "not-installed",
        message: "Context Mode is not installed.",
      }),
    });
    await expect(handlers.status({ fresh: false })).resolves.toEqual({
      state: "unavailable",
      code: "not-installed",
      message: "Context Mode is not installed.",
      checkedAt: "2026-09-20T00:00:00.000Z",
    });
  });

  test("caches brief status probes and keeps reports separate", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    let inspections = 0;
    const calls: string[] = [];
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "path",
        launch: launch("/bin/context-mode"),
      }),
      inspect: async () => {
        inspections += 1;
        return { version: "2.0.5", tools: ["ctx_doctor", "ctx_stats"] };
      },
      callTool: async (_launch, name) => {
        calls.push(name);
        return name === "ctx_doctor" ? "doctor" : "stats";
      },
    });

    const status = await handlers.status({ fresh: false });
    const cachedStatus = await handlers.status({ fresh: false });
    const refreshedStatus = await handlers.status({ fresh: true });
    const doctor = await handlers.doctor({ fresh: false });
    const stats = await handlers.stats({ fresh: false });
    const refreshedStats = await handlers.stats({ fresh: true });

    expect(status).toEqual(cachedStatus);
    expect(status).toMatchObject({ state: "ready", supportsDoctor: true, supportsStats: true });
    expect(refreshedStatus).toMatchObject({ state: "ready", version: "2.0.5" });
    expect(doctor).toMatchObject({ state: "ready", output: "doctor" });
    expect(stats).toMatchObject({ state: "ready", output: "stats" });
    expect(refreshedStats).toMatchObject({ state: "ready", output: "stats" });
    expect(inspections).toBe(2);
    expect(calls).toEqual(["ctx_doctor", "ctx_stats", "ctx_stats"]);
  });

  test("maps settings read failures to invalid settings reports", async () => {
    const handlers = createContextModeHandlers(
      {
        read: async () => {
          throw new Error("no settings");
        },
        subscribe: () => () => {},
      } as never,
      { now: () => new Date("2026-09-20T00:00:00.000Z") },
    );

    await expect(handlers.status({ fresh: false })).resolves.toMatchObject({
      state: "unavailable",
      code: "invalid-settings",
      message: expect.stringContaining("Could not read Context Mode settings: no settings"),
    });
  });

  test("returns invalid-settings when settings validation fails", async () => {
    const handlers = createContextModeHandlers(
      {
        read: async () => ({
          status: "invalid",
          revision: "test",
          error: "broken settings",
        }),
        subscribe: () => () => {},
      } as never,
      { now: () => new Date("2026-09-20T00:00:00.000Z") },
    );

    await expect(handlers.status({ fresh: false })).resolves.toMatchObject({
      state: "unavailable",
      code: "invalid-settings",
      message: expect.stringContaining("broken settings"),
    });
  });

  test("maps inspection failures to unavailable status reports", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "path",
        launch: launch("/bin/context-mode"),
      }),
      inspect: async () => {
        throw new Error("probe failed");
      },
    });

    await expect(handlers.status({ fresh: false })).resolves.toMatchObject({
      state: "unavailable",
      code: "command-failed",
      message: "probe failed",
    });
  });

  test("caches brief status probes and keeps reports separate", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    let inspections = 0;
    const calls: string[] = [];
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "path",
        launch: launch("/bin/context-mode"),
      }),
      inspect: async () => {
        inspections += 1;
        return { version: "2.0.5", tools: ["ctx_doctor", "ctx_stats"] };
      },
      callTool: async (_launch, name) => {
        calls.push(name);
        return name === "ctx_doctor" ? "doctor" : "stats";
      },
    });

    const status = await handlers.status({ fresh: false });
    const cachedStatus = await handlers.status({ fresh: false });
    const refreshedStatus = await handlers.status({ fresh: true });
    const doctor = await handlers.doctor({ fresh: false });
    const stats = await handlers.stats({ fresh: false });
    const refreshedStats = await handlers.stats({ fresh: true });

    expect(status).toEqual(cachedStatus);
    expect(status).toMatchObject({ state: "ready", supportsDoctor: true, supportsStats: true });
    expect(refreshedStatus).toMatchObject({ state: "ready", version: "2.0.5" });
    expect(doctor).toMatchObject({ state: "ready", output: "doctor" });
    expect(stats).toMatchObject({ state: "ready", output: "stats" });
    expect(refreshedStats).toMatchObject({ state: "ready", output: "stats" });
    expect(inspections).toBe(2);
    expect(calls).toEqual(["ctx_doctor", "ctx_stats", "ctx_stats"]);
  });

  test("falls back to a null audit version when inspection fails", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "path",
        launch: launch("/bin/context-mode"),
      }),
      inspect: async () => {
        throw new Error("probe failed");
      },
    });

    await expect(handlers.audit({ fresh: false })).resolves.toMatchObject({
      runtimeVersion: null,
      injectionEnabled: true,
    });
  });

  test("returns an empty audit when the binary is unavailable", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "missing",
        code: "not-installed",
        message: "Context Mode is not installed.",
      }),
    });

    await expect(handlers.audit({ fresh: false })).resolves.toEqual({
      runtimePath: "",
      runtimeVersion: null,
      injectionEnabled: false,
      providers: [],
      checkedAt: "2026-09-20T00:00:00.000Z",
    });
  });

  test("maps bounded process failures to clean RPC errors", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "path",
        launch: launch("/bin/context-mode"),
      }),
      callTool: async () => {
        throw new ProcessFailure("timeout", "Context Mode timed out.");
      },
    });
    await expect(handlers.stats({ fresh: false })).resolves.toMatchObject({
      state: "unavailable",
      code: "timeout",
      message: "Context Mode timed out.",
    });
  });
});
