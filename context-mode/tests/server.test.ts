import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readContextModeVersion, resolveContextModeBinary } from "../server/binary";
import { contextModeProbeOptions, createContextModeHandlers } from "../server/handlers";
import type { ProviderConfigSource } from "../server/integration";
import {
  CONTEXT_MODE_TOOL_TIMEOUT_MS,
  callContextModeTool,
  inspectContextMode,
  serverArgs,
} from "../server/mcp-process";
import {
  type ContextModeSettings,
  ContextModeSettingsSchema,
  type contextModeSettings,
} from "../shared/settings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

const PROBE = { platform: "claude-code", cwd: "/probe/cwd", dataDir: "/probe" } as const;
const options = { platform: "codex" } as const;
const noVersion = { readVersion: async () => null };
const ALL_TOOLS = [
  "ctx_execute",
  "ctx_batch",
  "ctx_index",
  "ctx_search",
  "ctx_resume",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
];

function settingsHandle(
  values: ContextModeSettings,
): PluginSettings<typeof contextModeSettings.schema> {
  return {
    read: async () => ({ status: "ready", revision: "test", values }),
    subscribe: () => () => {},
  };
}

const fakeMcpSource = `
if (process.argv.includes("--version")) {
  console.log("context-mode 2.1.4");
  process.exit(0);
}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "context-mode", version: "dev" } } }));
  }
  if (request.method === "tools/list") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: process.env.FAKE_TOOLS ? JSON.parse(process.env.FAKE_TOOLS) : [{ name: "ctx_execute" }, { name: "ctx_batch" }, { name: "ctx_index" }, { name: "ctx_search" }, { name: "ctx_resume" }, { name: "ctx_stats" }, { name: "ctx_doctor" }, { name: "ctx_upgrade" }, { name: "ctx_purge" }] } }));
  }
  if (request.method === "tools/call") {
    const text =
      request.params.name === "ctx_stats" ? "| Scope | Saved |" :
      request.params.name === "ctx_resume" ? [process.argv.slice(2).join(" "), process.cwd(), process.env.CONTEXT_MODE_DATA_DIR, JSON.stringify(request.params.arguments), JSON.stringify(request.params._meta), process.env.CLAUDE_PROJECT_DIR].join("\\n") :
      "| D1 version | PASS |";
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } }));
  }
});
`;

describe("Context Mode runtime resolution", () => {
  test("runs the user's own binary when one is configured", async () => {
    const settings = ContextModeSettingsSchema.parse({ binaryPath: "/opt/context-mode" });
    const result = await resolveContextModeBinary(settings, {
      platform: "linux",
      canExecute: async (path) => path === "/opt/context-mode",
      readVersion: async () => "2.1.5",
    });
    expect(result).toEqual({
      state: "found",
      path: "/opt/context-mode",
      source: "settings",
      launch: { program: "/opt/context-mode", args: [] },
    });
  });

  test("never falls back to the bundled runtime when the configured binary cannot run", async () => {
    const { paseo } = await pluginInstall();
    const settings = ContextModeSettingsSchema.parse({ binaryPath: "/missing/context-mode" });
    const missing = await resolveContextModeBinary(settings, {
      platform: "linux",
      canExecute: async () => false,
      paseo,
    });
    expect(missing).toMatchObject({ state: "missing", code: "not-installed" });

    const legacy = await resolveContextModeBinary(settings, {
      platform: "linux",
      canExecute: async () => true,
      readVersion: async () => "1.0.169",
      paseo,
    });
    expect(legacy).toMatchObject({ state: "missing", code: "unsupported" });
  });

  test.each(["", ".CMD", ".BAT"])(
    "resolves a configured Windows npm %s shim through node and its CLI module",
    async (extension) => {
      const shim = `C:\\npm\\context-mode${extension}`;
      const modulePath = "C:\\npm\\node_modules\\context-mode\\cli.mjs";
      const settings = ContextModeSettingsSchema.parse({ binaryPath: shim });
      const result = await resolveContextModeBinary(settings, {
        platform: "win32",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        canExecute: async (path) => path === shim,
        isFile: async (path) => path === modulePath,
        readVersion: async () => "2.1.4",
      });
      expect(result).toEqual({
        state: "found",
        path: shim,
        source: "settings",
        launch: { program: "C:\\Program Files\\nodejs\\node.exe", args: [modulePath] },
      });
    },
  );

  test("rejects a Windows command shim when its CLI module cannot be resolved", async () => {
    const settings = ContextModeSettingsSchema.parse({ binaryPath: "C:\\npm\\context-mode.CMD" });
    const result = await resolveContextModeBinary(settings, {
      platform: "win32",
      canExecute: async () => true,
      isFile: async () => false,
    });
    expect(result).toMatchObject({ state: "missing", code: "unsupported" });
  });

  test.each([
    [".exe", "C:\\npm\\context-mode.exe", []],
    [".mjs", "C:\\Program Files\\nodejs\\node.exe", ["C:\\npm\\context-mode.mjs"]],
  ])(
    "launches a configured Windows %s directly or through node",
    async (extension, program, args) => {
      const binaryPath = `C:\\npm\\context-mode${extension}`;
      const result = await resolveContextModeBinary(
        ContextModeSettingsSchema.parse({ binaryPath }),
        {
          platform: "win32",
          nodePath: "C:\\Program Files\\nodejs\\node.exe",
          canExecute: async (path) => path === binaryPath,
          isFile: async () => false,
          readVersion: async () => "2.1.4",
        },
      );
      expect(result).toEqual({
        state: "found",
        path: binaryPath,
        source: "settings",
        launch: { program, args },
      });
    },
  );

  async function pluginInstall(): Promise<{ paseo: ProviderConfigSource; cli: string }> {
    const root = await mkdtemp(join(tmpdir(), "paseo-context-mode-install-"));
    temporaryDirectories.push(root);
    async function writeJson(path: string, value: unknown) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    }
    async function contextModePackage(directory: string) {
      // 2.x exports only its OpenCode plugin; the CLI is not an export.
      await writeJson(join(directory, "package.json"), {
        name: "context-mode",
        version: "2.1.4",
        main: "./opencode/plugin.js",
        exports: { ".": "./opencode/plugin.js", "./server": "./opencode/plugin.js" },
      });
      await mkdir(join(directory, "opencode"), { recursive: true });
      await writeFile(join(directory, "opencode", "plugin.js"), "");
      await writeFile(join(directory, "cli.mjs"), "");
      return realpath(join(directory, "cli.mjs"));
    }
    // npm layout: the plugin package and its dependencies are siblings under node_modules.
    const plugin = join(root, "context-mode", "install", "node_modules", "@omercnet", "plugin");
    await writeJson(join(plugin, "paseo-plugin.json"), { id: "context-mode" });
    await writeJson(join(plugin, "package.json"), { name: "@omercnet/plugin" });
    const cli = await contextModePackage(
      join(root, "context-mode", "install", "node_modules", "context-mode"),
    );
    // Another plugin that happens to ship its own Context Mode must not be picked.
    const other = join(root, "other");
    await writeJson(join(other, "paseo-plugin.json"), { id: "other" });
    await writeJson(join(other, "package.json"), { name: "other" });
    await contextModePackage(join(other, "node_modules", "context-mode"));
    const paseo: ProviderConfigSource = {
      config: {
        get: async () => ({
          config: {
            plugins: {
              other: { source: "directory", path: other },
              "renamed-context-mode": { source: "directory", path: plugin },
            },
          },
        }),
      },
    };
    return { paseo, cli };
  }

  test("runs the bundled runtime by default, even with another context-mode on PATH", async () => {
    const { paseo, cli } = await pluginInstall();
    vi.stubEnv("PATH", dirname(process.execPath));
    const result = await resolveContextModeBinary(ContextModeSettingsSchema.parse({}), {
      nodePath: "/usr/bin/node",
      electron: false,
      canExecute: async () => true,
      paseo,
    });
    expect(result).toEqual({
      state: "found",
      path: cli,
      source: "bundled",
      launch: { program: "/usr/bin/node", args: [cli] },
    });
    await expect(readContextModeVersion({ program: "/usr/bin/node", args: [cli] })).resolves.toBe(
      "2.1.4",
    );
  });

  test("launches the bundled runtime as Node when the host is Electron", async () => {
    const { paseo, cli } = await pluginInstall();
    const result = await resolveContextModeBinary(ContextModeSettingsSchema.parse({}), {
      nodePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
      electron: true,
      paseo,
    });
    expect(result).toMatchObject({
      state: "found",
      launch: {
        program: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        args: [cli],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    });
  });

  test("reports a missing bundled runtime instead of searching elsewhere", async () => {
    const result = await resolveContextModeBinary(ContextModeSettingsSchema.parse({}), {
      canExecute: async () => true,
      paseo: { config: { get: async () => ({ config: { plugins: {} } }) } },
    });
    expect(result).toMatchObject({ state: "missing", code: "not-installed" });
  });
});

describe("bounded Context Mode process", () => {
  test("runs the stdio server for the requested agent", () => {
    expect(serverArgs({ program: "/usr/bin/node", args: ["/pkg/cli.mjs"] }, "copilot-cli")).toEqual(
      {
        command: "/usr/bin/node",
        args: ["/pkg/cli.mjs", "server", "--agent", "copilot-cli"],
      },
    );
  });

  test("reports the CLI version instead of the handshake's dev label", async () => {
    const binary = await executable(fakeMcpSource);
    await expect(inspectContextMode(launch(binary))).resolves.toEqual({
      version: "2.1.4",
      tools: ALL_TOOLS,
    });
  });

  test("reads the version from the package.json beside the CLI", async () => {
    const binary = await executable(fakeMcpSource);
    await writeFile(
      join(dirname(binary), "package.json"),
      JSON.stringify({ name: "context-mode", version: "2.1.9" }),
    );
    await expect(inspectContextMode(launch(binary))).resolves.toMatchObject({ version: "2.1.9" });
  });

  test("reports a runtime without the 2.x core tools as unsupported", async () => {
    const binary = await executable(fakeMcpSource);
    await expect(
      inspectContextMode({
        ...launch(binary),
        env: { FAKE_TOOLS: JSON.stringify([{ name: "ctx_doctor" }, { name: "ctx_stats" }]) },
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("ctx_index, ctx_search, ctx_resume, ctx_purge"),
    });
  });

  test("explains a doctor-only runtime as a Node.js problem", async () => {
    const binary = await executable(fakeMcpSource);
    await expect(
      inspectContextMode({
        ...launch(binary),
        env: { FAKE_TOOLS: JSON.stringify([{ name: "ctx_doctor" }]) },
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("Node.js 24.15"),
    });
  });

  test("passes agent, cwd, data dir and the plugin session to the server", async () => {
    const binary = await executable(fakeMcpSource);
    const cwd = await realpath(dirname(binary));
    await expect(
      callContextModeTool(launch(binary), "ctx_resume", { session: "s1" }, noVersion, {
        platform: "opencode",
        cwd,
        dataDir: "/data/cm",
      }),
    ).resolves.toBe(
      `server --agent opencode\n${cwd}\n/data/cm\n{"session":"s1"}\n{"sessionId":"paseo-context-mode"}\n`,
    );
    await expect(callContextModeTool(launch(binary), "ctx_doctor", {}, {}, options)).resolves.toBe(
      "| D1 version | PASS |",
    );
  });

  test("pins Claude Code's project to the requested cwd", async () => {
    const binary = await executable(fakeMcpSource);
    const cwd = await realpath(dirname(binary));
    vi.stubEnv("CLAUDE_PROJECT_DIR", "/elsewhere");
    const output = await callContextModeTool(launch(binary), "ctx_resume", {}, noVersion, {
      platform: "claude-code",
      cwd,
    });
    expect(output.split("\n").at(-1)).toBe(cwd);
  });

  test("starts the process with the launch environment", async () => {
    const binary = await executable(fakeMcpSource);
    await expect(
      callContextModeTool(
        { ...launch(binary), env: { CONTEXT_MODE_DATA_DIR: "/from-launch" } },
        "ctx_resume",
        {},
        {},
        options,
      ),
    ).resolves.toContain("/from-launch");
  });

  test("rejects a failed initialize response with the upstream message", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boot failed" } }));
});
`);
    await expect(inspectContextMode(launch(binary), noVersion)).rejects.toMatchObject({
      code: "protocol-error",
      message: "boot failed",
    });
  });

  test("marks unsupported tool errors separately from command failures", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "dev" } } }));
  if (request.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "tool not found" } }));
});
`);
    await expect(
      callContextModeTool(launch(binary), "ctx_doctor", {}, {}, options),
    ).rejects.toMatchObject({
      code: "unsupported",
      message: "tool not found",
    });
  });

  test("budgets long-running Context Mode tools", () => {
    expect(CONTEXT_MODE_TOOL_TIMEOUT_MS.ctx_index).toBeGreaterThan(30_000);
    expect(CONTEXT_MODE_TOOL_TIMEOUT_MS.ctx_purge).toBeGreaterThan(30_000);
  });

  test("allows Context Mode to exit cleanly after a successful exchange", async () => {
    const signals: NodeJS.Signals[] = [];
    const spawned: string[][] = [];
    const stdout = new PassThrough();
    const emitter = new EventEmitter();
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString()) as { id?: number };
        callback();
        if (request.id === 1) {
          queueMicrotask(() =>
            stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "dev" } } })}\n`,
            ),
          );
        } else if (request.id === 2) {
          queueMicrotask(() =>
            stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "ctx_execute" }, { name: "ctx_batch" }, { name: "ctx_index" }, { name: "ctx_search" }, { name: "ctx_resume" }, { name: "ctx_stats" }, { name: "ctx_doctor" }, { name: "ctx_upgrade" }, { name: "ctx_purge" }] } })}\n`,
            ),
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
    const spawnProcess = ((command: string, args: string[]) => {
      spawned.push([command, ...args]);
      return child;
    }) as unknown as typeof spawn;

    await expect(
      inspectContextMode(launch("ignored"), {
        spawnProcess,
        terminationGraceMs: 20,
        readVersion: async () => "2.1.4",
      }),
    ).resolves.toEqual({ version: "2.1.4", tools: ALL_TOOLS });
    expect(signals).toEqual(["SIGTERM"]);
    expect(spawned[0]?.slice(-3)).toEqual(["server", "--agent", "claude-code"]);
  });

  test("terminates commands that time out", async () => {
    const binary = await executable("process.stdin.resume();");
    await expect(
      inspectContextMode(launch(binary), { ...noVersion, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  test("terminates commands that exceed the output cap", async () => {
    const binary = await executable(
      'process.stdout.write("x".repeat(4096)); process.stdin.resume();',
    );
    await expect(
      inspectContextMode(launch(binary), { ...noVersion, outputLimit: 128 }),
    ).rejects.toMatchObject({ code: "output-limit" });
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
        ...noVersion,
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
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "dev" } } }));
  if (request.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "" }], structuredContent: { savedBytes: 17825792 } } }));
});
`);
    await expect(callContextModeTool(launch(binary), "ctx_search", {}, {}, options)).resolves.toBe(
      '{\n  "savedBytes": 17825792\n}',
    );
  });

  test("maps MCP tool isError results to command failures", async () => {
    const binary = await executable(`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "dev" } } }));
  if (request.method === "tools/call") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "upstream failure" }], isError: true } }));
});
`);
    await expect(
      callContextModeTool(launch(binary), "ctx_doctor", {}, {}, options),
    ).rejects.toMatchObject({
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

  test("caches brief status probes until a fresh read is requested", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    let inspections = 0;
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "settings",
        launch: launch("/bin/context-mode"),
      }),
      probeOptions: async () => PROBE,
      inspect: async () => {
        inspections += 1;
        return { version: "2.1.4", tools: ALL_TOOLS };
      },
    });

    const status = await handlers.status({ fresh: false });
    const cachedStatus = await handlers.status({ fresh: false });
    const refreshedStatus = await handlers.status({ fresh: true });

    expect(status).toEqual(cachedStatus);
    expect(status).toMatchObject({ state: "ready", version: "2.1.4" });
    expect(refreshedStatus).toMatchObject({ state: "ready", version: "2.1.4" });
    expect(inspections).toBe(2);
  });

  test("keeps probe stores and cwd under PASEO_HOME, never the user's data dir", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-context-mode-home-"));
    temporaryDirectories.push(home);
    const dataDir = join(home, "plugin-data", "context-mode", "probe");

    await expect(contextModeProbeOptions("codex", { PASEO_HOME: home })).resolves.toEqual({
      platform: "codex",
      cwd: join(dataDir, "cwd"),
      dataDir,
    });
    await expect(realpath(join(dataDir, "cwd"))).resolves.toBeTruthy();
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
        source: "settings",
        launch: launch("/bin/context-mode"),
      }),
      probeOptions: async () => PROBE,
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

  test("audits providers configured in the daemon without starting Context Mode", async () => {
    const settings = ContextModeSettingsSchema.parse({});
    const createAudit = vi.fn(async () => ({ providers: [] }));
    const inspect = vi.fn();
    const handlers = createContextModeHandlers(settingsHandle(settings), {
      resolveBinary: async () => ({
        state: "found",
        path: "/bin/context-mode",
        source: "settings",
        launch: launch("/bin/context-mode"),
      }),
      probeOptions: async () => PROBE,
      inspect,
      createAudit,
    });
    const paseo = {
      config: {
        get: async () => ({
          config: { providers: { "claude-work": { extends: "claude", env: { A: "1" } } } },
        }),
      },
    };

    await handlers.audit({}, { paseo });

    expect(createAudit).toHaveBeenCalledWith(settings, {
      providers: { "claude-work": { extends: "claude", env: { A: "1" } } },
    });
    expect(inspect).not.toHaveBeenCalled();
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

    await expect(handlers.audit({})).resolves.toEqual({ providers: [] });
  });
});
