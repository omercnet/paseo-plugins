import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { AnalyticsWarning } from "../shared/analytics";

const MAX_DATABASES_PER_DIRECTORY = 512;
const MAX_LOCAL_DISCOVERY_WARNINGS = 10;

export interface ProviderStorageRoot {
  provider: string;
  root: string;
  sessionsDir: string;
  contentDir: string;
}

export interface StorageDiscoveryResult {
  roots: ProviderStorageRoot[];
  warnings: AnalyticsWarning[];
}

export interface StorageDiscoveryOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

interface ProviderLocation {
  provider: string;
  root: string;
}

function configuredDirectory(
  value: string | undefined,
  home: string,
  envVar: string,
  warnings: AnalyticsWarning[],
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(home, trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) return resolve(trimmed);
  warnings.push({
    code: "invalid-storage-root",
    message: `${envVar} was ignored because it is not an absolute path.`,
  });
  return null;
}

function providerLocations(
  home: string,
  env: NodeJS.ProcessEnv,
  warnings: AnalyticsWarning[],
  platform: NodeJS.Platform,
): ProviderLocation[] {
  const configuredRoot = configuredDirectory(
    env.CONTEXT_MODE_DIR,
    home,
    "CONTEXT_MODE_DIR",
    warnings,
  );
  const configuredDataRoot = configuredDirectory(
    env.CONTEXT_MODE_DATA_DIR,
    home,
    "CONTEXT_MODE_DATA_DIR",
    warnings,
  );
  const claudeRoot =
    configuredDirectory(env.CLAUDE_CONFIG_DIR, home, "CLAUDE_CONFIG_DIR", warnings) ??
    join(home, ".claude");
  const codexRoot =
    configuredDirectory(env.CODEX_HOME, home, "CODEX_HOME", warnings) ?? join(home, ".codex");
  const kimiRoot =
    configuredDirectory(env.KIMI_CODE_HOME, home, "KIMI_CODE_HOME", warnings) ??
    join(home, ".kimi-code");
  const xdgRoot =
    platform === "win32"
      ? (configuredDirectory(env.APPDATA, home, "APPDATA", warnings) ??
        join(home, "AppData", "Roaming"))
      : (configuredDirectory(env.XDG_CONFIG_HOME, home, "XDG_CONFIG_HOME", warnings) ??
        join(home, ".config"));

  return [
    ...(configuredRoot ? [{ provider: "custom", root: configuredRoot }] : []),
    ...(configuredDataRoot
      ? [{ provider: "custom-data", root: join(configuredDataRoot, "context-mode") }]
      : []),
    { provider: "claude-code", root: join(claudeRoot, "context-mode") },
    { provider: "gemini-cli", root: join(home, ".gemini", "context-mode") },
    { provider: "openclaw", root: join(home, ".openclaw", "context-mode") },
    { provider: "codex", root: join(codexRoot, "context-mode") },
    { provider: "cursor", root: join(home, ".cursor", "context-mode") },
    { provider: "vscode-copilot", root: join(home, ".vscode", "context-mode") },
    { provider: "copilot-cli", root: join(home, ".copilot", "context-mode") },
    { provider: "kiro", root: join(home, ".kiro", "context-mode") },
    { provider: "pi", root: join(home, ".pi", "context-mode") },
    { provider: "omp", root: join(home, ".omp", "context-mode") },
    { provider: "qwen-code", root: join(home, ".qwen", "context-mode") },
    { provider: "kimi", root: join(kimiRoot, "context-mode") },
    { provider: "kilo", root: join(xdgRoot, "kilo", "context-mode") },
    { provider: "opencode", root: join(xdgRoot, "opencode", "context-mode") },
    { provider: "zed", root: join(home, ".config", "zed", "context-mode") },
    {
      provider: "jetbrains-copilot",
      root: join(home, ".config", "JetBrains", "context-mode"),
    },
  ];
}

function storageWarning(provider: string, message: string, database?: string): AnalyticsWarning {
  return {
    code: "storage-unavailable",
    provider,
    ...(database ? { database } : {}),
    message,
  };
}

export async function discoverContextModeStorageRoots(
  options: StorageDiscoveryOptions = {},
): Promise<StorageDiscoveryResult> {
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const warnings: AnalyticsWarning[] = [];
  const roots: ProviderStorageRoot[] = [];
  const seen = new Set<string>();

  for (const location of providerLocations(
    home,
    env,
    warnings,
    options.platform ?? process.platform,
  )) {
    try {
      const info = await lstat(location.root);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        warnings.push(
          storageWarning(
            location.provider,
            "The Context Mode storage root is not a regular directory.",
          ),
        );
        continue;
      }
      const canonical = await realpath(location.root);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      roots.push({
        provider: location.provider,
        root: canonical,
        sessionsDir: join(canonical, "sessions"),
        contentDir: join(canonical, "content"),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      warnings.push(
        storageWarning(location.provider, "The Context Mode storage root could not be inspected."),
      );
    }
  }

  return { roots, warnings };
}

export async function listRegularContextModeDatabases(
  provider: string,
  directory: string,
): Promise<{ files: string[]; warnings: AnalyticsWarning[] }> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], warnings: [] };
    return {
      files: [],
      warnings: [
        storageWarning(
          provider,
          `The ${basename(directory)} database directory could not be read.`,
        ),
      ],
    };
  }

  const candidates = entries
    .filter((entry) => entry.name.endsWith(".db"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  const warnings: AnalyticsWarning[] = [];

  for (const entry of candidates.slice(0, MAX_DATABASES_PER_DIRECTORY)) {
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (entry.isFile() && info.isFile()) {
        files.push(path);
      } else if (warnings.length < MAX_LOCAL_DISCOVERY_WARNINGS) {
        warnings.push({
          code: "not-regular-database",
          provider,
          database: entry.name,
          message: "Skipped a .db entry that is not a regular file.",
        });
      }
    } catch {
      if (warnings.length < MAX_LOCAL_DISCOVERY_WARNINGS) {
        warnings.push(
          storageWarning(provider, "A database disappeared during discovery.", entry.name),
        );
      }
    }
  }

  if (candidates.length > MAX_DATABASES_PER_DIRECTORY) {
    warnings.push({
      code: "result-truncated",
      provider,
      message: `Only the first ${MAX_DATABASES_PER_DIRECTORY} database files in ${basename(directory)} were inspected.`,
    });
  }

  return { files, warnings };
}
