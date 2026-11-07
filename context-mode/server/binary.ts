import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import type { ContextModeSettings } from "../shared/settings";
import type { ProviderConfigSource } from "./integration";

export interface LaunchDescriptor {
  program: string;
  args: string[];
  env?: Record<string, string>;
}

export type BinaryResolution =
  | {
      state: "found";
      path: string;
      source: "settings" | "bundled";
      launch: LaunchDescriptor;
    }
  | { state: "missing"; code: "not-installed" | "unsupported"; message: string };

export interface BinaryResolutionDependencies {
  platform?: NodeJS.Platform;
  nodePath?: string;
  electron?: boolean;
  canExecute?: (path: string) => Promise<boolean>;
  isFile?: (path: string) => Promise<boolean>;
  readVersion?: (launch: LaunchDescriptor) => Promise<string | null>;
  paseo?: ProviderConfigSource;
}

/**
 * Paseo evaluates the server bundle from the daemon's cwd with an empty `import.meta`, so the
 * bundled runtime is resolved from this plugin's directory in the daemon config instead.
 */
async function findBundledCli(paseo: ProviderConfigSource | undefined): Promise<string | null> {
  const { config } = (await paseo?.config.get().catch(() => undefined)) ?? {};
  const plugins = config?.plugins;
  if (typeof plugins !== "object" || plugins === null) return null;
  for (const source of Object.values(plugins)) {
    const directory = (source as { path?: unknown } | null)?.path;
    if (typeof directory !== "string") continue;
    try {
      const manifest = JSON.parse(await readFile(join(directory, "paseo-plugin.json"), "utf8"));
      if (manifest?.id !== "context-mode") continue;
      // The package exports only its OpenCode plugin (`<root>/opencode/plugin.js`); the CLI sits at the root.
      const main = createRequire(join(directory, "package.json")).resolve("context-mode");
      return join(dirname(dirname(main)), "cli.mjs");
    } catch {
      // Not this plugin, or its install has no bundled runtime.
    }
  }
  return null;
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function defaultCanExecute(path: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!(await defaultIsFile(path))) return false;
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function windowsLaunchDescriptor(
  candidate: string,
  nodePath: string,
  isFile: (path: string) => Promise<boolean>,
): Promise<LaunchDescriptor | null> {
  const extension = win32.extname(candidate).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return { program: candidate, args: [] };
  }
  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return { program: nodePath, args: [candidate] };
  }

  const directory = win32.dirname(candidate);
  const moduleCandidates = [
    win32.join(directory, "node_modules", "context-mode", "cli.mjs"),
    win32.join(directory, "..", "context-mode", "cli.mjs"),
  ];
  for (const modulePath of moduleCandidates) {
    if (await isFile(modulePath)) return { program: nodePath, args: [modulePath] };
  }
  return null;
}

/**
 * The user's own binary when one is configured, else the runtime bundled with the plugin. A
 * configured binary that cannot run is reported, never silently replaced by the bundled one.
 */
export async function resolveContextModeBinary(
  settings: ContextModeSettings,
  dependencies: BinaryResolutionDependencies = {},
): Promise<BinaryResolution> {
  const platform = dependencies.platform ?? process.platform;
  const nodePath = dependencies.nodePath ?? process.execPath;
  if (settings.binaryPath !== null) {
    return resolveConfiguredBinary(settings.binaryPath, {
      platform,
      nodePath,
      canExecute: dependencies.canExecute ?? ((path: string) => defaultCanExecute(path, platform)),
      isFile: dependencies.isFile ?? defaultIsFile,
      readVersion: dependencies.readVersion ?? readContextModeVersion,
    });
  }

  const bundledCli = await findBundledCli(dependencies.paseo);
  if (!bundledCli) {
    return {
      state: "missing",
      code: "not-installed",
      message:
        "The bundled Context Mode runtime is missing from this plugin install. Reinstall the plugin or configure your own binary.",
    };
  }
  const canonicalPath = await realpath(bundledCli).catch(() => bundledCli);
  // Under the desktop app `nodePath` is Electron. Paseo strips this variable from agent
  // environments, so an injected MCP server needs it to start as Node.
  const electron = dependencies.electron ?? process.versions.electron !== undefined;
  return {
    state: "found",
    path: canonicalPath,
    source: "bundled",
    launch: {
      program: nodePath,
      args: [canonicalPath],
      ...(electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
    },
  };
}

interface ConfiguredBinaryChecks {
  platform: NodeJS.Platform;
  nodePath: string;
  canExecute: (path: string) => Promise<boolean>;
  isFile: (path: string) => Promise<boolean>;
  readVersion: (launch: LaunchDescriptor) => Promise<string | null>;
}

async function resolveConfiguredBinary(
  configuredPath: string,
  checks: ConfiguredBinaryChecks,
): Promise<BinaryResolution> {
  if (!(await checks.canExecute(configuredPath))) {
    return {
      state: "missing",
      code: "not-installed",
      message: `The configured Context Mode binary (${configuredPath}) is missing or not executable.`,
    };
  }
  const canonicalPath = await realpath(configuredPath).catch(() => configuredPath);
  const launch =
    checks.platform === "win32"
      ? await windowsLaunchDescriptor(canonicalPath, checks.nodePath, checks.isFile)
      : { program: canonicalPath, args: [] };
  if (!launch) {
    return {
      state: "missing",
      code: "unsupported",
      message: `The configured Context Mode binary (${canonicalPath}) is a Windows shim whose CLI module could not be found. Configure the absolute cli.mjs path instead.`,
    };
  }
  // 1.x starts a server but lacks the 2.x tool contracts the plugin and injected agents rely on.
  const version = await checks.readVersion(launch);
  if (version !== null && Number.parseInt(version, 10) < 2) {
    return {
      state: "missing",
      code: "unsupported",
      message: `The configured Context Mode binary is version ${version}; Context Mode 2 is required. Point it at a 2.x install or switch back to the bundled runtime.`,
    };
  }
  return { state: "found", path: canonicalPath, source: "settings", launch };
}

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
/** `--version` results per entry file; status, audit and every RPC resolve the binary again. */
const cliVersions = new Map<string, { mtimeMs: number; version: string | null }>();

/**
 * The MCP handshake reports `dev` for npm builds, so the version comes from the package.json beside
 * the CLI entry when it is a Context Mode install, else from `context-mode --version`, which only
 * runs again once the entry file changes.
 */
export async function readContextModeVersion(
  launch: LaunchDescriptor,
  timeoutMs = 5_000,
): Promise<string | null> {
  const entry = launch.args[0] ?? launch.program;
  try {
    const manifest = JSON.parse(await readFile(join(dirname(entry), "package.json"), "utf8"));
    if (manifest?.name === "context-mode" && typeof manifest.version === "string") {
      return manifest.version.slice(0, 128);
    }
  } catch {
    // Not a package directory; ask the CLI.
  }
  const mtimeMs = (await stat(entry).catch(() => null))?.mtimeMs;
  const cached = cliVersions.get(entry);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  let version: string | null = null;
  try {
    const { stdout } = await promisify(execFile)(launch.program, [...launch.args, "--version"], {
      timeout: timeoutMs,
      windowsHide: true,
      env: launch.env ? { ...process.env, ...launch.env } : undefined,
    });
    version = VERSION_PATTERN.exec(stdout)?.[0] ?? null;
  } catch {
    // Unknown version: not treated as 1.x.
  }
  // An unknown version is not cached: a timed-out probe must not let a 1.x binary past the gate.
  if (mtimeMs !== undefined && version !== null) cliVersions.set(entry, { mtimeMs, version });
  return version;
}
