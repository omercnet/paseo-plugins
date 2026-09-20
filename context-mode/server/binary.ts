import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix, win32 } from "node:path";
import type { ContextModeSettings } from "../shared";

export interface LaunchDescriptor {
  program: string;
  args: string[];
}

export type BinaryResolution =
  | {
      state: "found";
      path: string;
      source: "settings" | "path" | "bundled";
      launch: LaunchDescriptor;
    }
  | { state: "missing"; code: "not-installed" | "unsupported"; message: string };

export interface BinaryResolutionDependencies {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodePath?: string;
  canExecute?: (path: string) => Promise<boolean>;
  isFile?: (path: string) => Promise<boolean>;
  bundledCliPath?: () => string | null;
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

function pathCandidates(
  name: string,
  directory: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) {
  const pathApi = platform === "win32" ? win32 : posix;
  if (platform !== "win32") return [pathApi.join(directory, name)];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [
    pathApi.join(directory, name),
    ...extensions.map((extension) => pathApi.join(directory, `${name}${extension}`)),
  ];
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
    win32.join(directory, "node_modules", "context-mode", "cli.bundle.mjs"),
    win32.join(directory, "node_modules", "context-mode", "build", "cli.js"),
    win32.join(directory, "..", "context-mode", "cli.bundle.mjs"),
    win32.join(directory, "..", "context-mode", "build", "cli.js"),
  ];
  for (const modulePath of moduleCandidates) {
    if (await isFile(modulePath)) return { program: nodePath, args: [modulePath] };
  }
  return null;
}

export async function resolveContextModeBinary(
  settings: ContextModeSettings,
  dependencies: BinaryResolutionDependencies = {},
): Promise<BinaryResolution> {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const nodePath = dependencies.nodePath ?? process.execPath;
  const canExecute =
    dependencies.canExecute ?? ((path: string) => defaultCanExecute(path, platform));
  const isFile = dependencies.isFile ?? defaultIsFile;
  const configuredPath = settings.binaryPath.trim();
  let unsupportedShim: string | null = null;

  async function resolveCandidate(
    candidate: string,
    source: "settings" | "path",
  ): Promise<Extract<BinaryResolution, { state: "found" }> | null> {
    if (!(await canExecute(candidate))) return null;
    const canonicalPath = await realpath(candidate).catch(() => candidate);
    if (platform !== "win32") {
      return {
        state: "found",
        path: canonicalPath,
        source,
        launch: { program: canonicalPath, args: [] },
      };
    }
    const launch = await windowsLaunchDescriptor(canonicalPath, nodePath, isFile);
    if (!launch) {
      unsupportedShim = canonicalPath;
      return null;
    }
    return { state: "found", path: canonicalPath, source, launch };
  }

  if (settings.binaryMode === "path" && configuredPath.length > 0) {
    if (!pathApi.isAbsolute(configuredPath)) {
      return {
        state: "missing",
        code: "not-installed",
        message: "The configured Context Mode binary path is not absolute.",
      };
    }
    const configured = await resolveCandidate(configuredPath, "settings");
    if (configured) return configured;
  }

  for (const directory of (env.PATH ?? "").split(pathApi.delimiter).filter(Boolean)) {
    for (const candidate of pathCandidates("context-mode", directory, platform, env)) {
      const resolved = await resolveCandidate(candidate, "path");
      if (resolved) return resolved;
    }
  }

  const bundledCandidates: string[] = [];
  const injectedBundledPath = dependencies.bundledCliPath?.();
  if (injectedBundledPath) bundledCandidates.push(injectedBundledPath);
  if (!dependencies.bundledCliPath) {
    bundledCandidates.push(join(process.cwd(), "node_modules", "context-mode", "cli.bundle.mjs"));
    try {
      bundledCandidates.push(createRequire(import.meta.url).resolve("context-mode/cli"));
    } catch {
      // The plugin bundle may run outside the dependency tree; the cwd candidate remains valid.
    }
  }
  for (const bundledCli of new Set(bundledCandidates)) {
    if (!(await isFile(bundledCli))) continue;
    const canonicalPath = await realpath(bundledCli).catch(() => bundledCli);
    return {
      state: "found",
      path: canonicalPath,
      source: "bundled",
      launch: { program: nodePath, args: [canonicalPath] },
    };
  }

  if (unsupportedShim) {
    return {
      code: "unsupported",
      state: "missing",
      message: `Context Mode was found at ${unsupportedShim}, but this Windows shim could not be safely resolved to its CLI module. Reinstall Context Mode with npm or configure the absolute cli.bundle.mjs path.`,
    };
  }
  const configuredDetail =
    settings.binaryMode === "path" && configuredPath.length > 0
      ? ` The configured path (${configuredPath}) was unavailable, and no fallback was found on PATH.`
      : "";
  return {
    code: "not-installed",
    state: "missing",
    message: `Context Mode is not installed or is not executable on this Paseo host.${configuredDetail}`,
  };
}
