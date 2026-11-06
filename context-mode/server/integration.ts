import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ContextModePlatform,
  ContextModeSettings,
  IntegrationAudit,
  ProviderIntegration,
} from "../shared";
import type { LaunchDescriptor } from "./binary";
import { serverArgs } from "./mcp-process";
import { resolveContextModeDataDir } from "./storage-discovery";

/** Paseo providers whose agents can run the Context Mode 2.x stdio MCP server. */
const SUPPORTED_PLATFORMS: Readonly<Record<string, ContextModePlatform>> = {
  claude: "claude-code",
  codex: "codex",
  copilot: "copilot-cli",
  opencode: "opencode",
};

/** Context Mode 2.x needs an in-process host context for these, so MCP injection cannot work. */
const UNSUPPORTED_DETAIL: Readonly<Record<string, string>> = {
  cursor:
    "Context Mode 2.x has no Cursor integration, so nothing is injected. Its MCP server rejects every tool call without a supported agent.",
  pi: "Context Mode 2.x runs inside Pi as an in-process extension, so no MCP server is injected. Install it natively with `pi install npm:context-mode`.",
  omp: "Context Mode 2.x has no OMP integration, so nothing is injected. Its MCP server rejects every tool call without a supported agent.",
  "omp-plugin":
    "Context Mode 2.x has no OMP integration, so nothing is injected. Its MCP server rejects every tool call without a supported agent.",
};

const AUDITED_PROVIDERS = [...Object.keys(SUPPORTED_PLATFORMS), ...Object.keys(UNSUPPORTED_DETAIL)];

type McpServer = {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
};

type CreateRequest = {
  config: {
    provider: string;
    cwd?: string;
    internal?: boolean;
    mcpServers?: Readonly<Record<string, unknown>>;
  };
  env?: Readonly<Record<string, string>>;
};

export interface IntegrationDependencies {
  home?: string;
  pathExists?: (path: string) => Promise<boolean>;
  fileContains?: (path: string, text: string) => Promise<boolean>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  providers?: ProviderOverrides;
}

export type ProviderOverrides = Readonly<
  Record<string, { extends?: string; env?: Readonly<Record<string, string>> }>
>;

/** Structural slice of the hook/RPC `paseo` API; avoids a client-package import. */
export interface ProviderConfigSource {
  config: { get(): Promise<{ config: { providers?: unknown; plugins?: unknown } }> };
}

/**
 * Reads `agents.providers` from the daemon so a derived provider (`extends`) maps like its parent
 * and its own `env` (for example `CODEX_HOME`) locates its native config. Failures degrade to
 * "no overrides" (canonical provider behavior).
 */
export async function readProviderOverrides(
  paseo: ProviderConfigSource | undefined,
): Promise<ProviderOverrides> {
  try {
    const { config } = (await paseo?.config.get()) ?? {};
    const entries: Array<[string, { extends?: string; env?: Record<string, string> }]> = [];
    for (const [id, value] of Object.entries(config?.providers ?? {})) {
      if (typeof value !== "object" || value === null) continue;
      const { extends: parent, env } = value as { extends?: unknown; env?: unknown };
      entries.push([
        id,
        {
          ...(typeof parent === "string" ? { extends: parent } : {}),
          ...(typeof env === "object" && env !== null && !Array.isArray(env)
            ? {
                env: Object.fromEntries(
                  Object.entries(env).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                ),
              }
            : {}),
        },
      ]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

/**
 * Mirrors Paseo's single-level `extends`: a derived provider maps like its parent, and its
 * effective env is the parent's override env overlaid with its own.
 */
function resolveProvider(
  id: string,
  providers: ProviderOverrides,
): { base: string; env: Record<string, string> } {
  const own = Object.hasOwn(providers, id) ? providers[id] : undefined;
  const parent = own?.extends ?? id;
  const inherited =
    parent !== id && Object.hasOwn(providers, parent) ? providers[parent] : undefined;
  const base = parent.startsWith("omp-plugin-") ? "omp-plugin" : parent;
  return { base, env: { ...inherited?.env, ...own?.env } };
}

type ProbeContext = {
  home: string;
  cwd?: string;
  env: Readonly<Record<string, string | undefined>>;
};

type NativeProbe = { kind: "path"; path: string } | { kind: "file"; path: string; marker: string };

/**
 * Where `context-mode setup` (or the agent's own plugin install) registers Context Mode, with
 * config homes resolved as setup resolves them (an empty variable means unset).
 */
function nativeProbes(platform: ContextModePlatform, { home, cwd, env }: ProbeContext) {
  const probes: NativeProbe[] = [];
  const file = (path: string, marker = "context-mode") =>
    probes.push({ kind: "file", path, marker });
  switch (platform) {
    case "claude-code": {
      const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
      file(join(claude, "plugins", "installed_plugins.json"), '"context-mode@context-mode"');
      file(join(claude, "settings.json"), '"context-mode@context-mode"');
      file(join(home, ".claude.json"), '"context-mode":');
      break;
    }
    case "codex": {
      const config = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
      file(config, "[mcp_servers.context-mode]");
      file(config, '[plugins."context-mode@context-mode"]');
      break;
    }
    case "copilot-cli": {
      const copilot = env.COPILOT_HOME || join(home, ".copilot");
      file(join(copilot, "mcp-config.json"), '"context-mode"');
      probes.push({ kind: "path", path: join(copilot, "hooks", "context-mode.json") });
      break;
    }
    case "opencode": {
      const opencode =
        env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
      const names = ["opencode.jsonc", "opencode.json"];
      for (const name of names) file(join(opencode, name));
      if (cwd) {
        for (const name of names) {
          file(join(cwd, name));
          file(join(cwd, ".opencode", name));
        }
      }
      break;
    }
  }
  return probes;
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isDirectory() || metadata.isFile();
  } catch {
    return false;
  }
}

async function defaultFileContains(path: string, text: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return false;
    return (await readFile(path, "utf8")).includes(text);
  } catch {
    return false;
  }
}

async function nativeIntegrationDetected(
  platform: ContextModePlatform,
  context: ProbeContext,
  dependencies: IntegrationDependencies,
): Promise<boolean> {
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const fileContains = dependencies.fileContains ?? defaultFileContains;
  for (const probe of nativeProbes(platform, context)) {
    if (
      probe.kind === "path"
        ? await pathExists(probe.path)
        : await fileContains(probe.path, probe.marker)
    ) {
      return true;
    }
  }
  return false;
}

export async function createIntegrationAudit(
  settings: ContextModeSettings,
  runtime: { path: string; version: string | null },
  dependencies: IntegrationDependencies = {},
): Promise<IntegrationAudit> {
  const home = dependencies.home ?? homedir();
  const hostEnvironment = dependencies.env ?? process.env;
  const storageRoot = resolveContextModeDataDir(hostEnvironment, home);
  const configured = dependencies.providers ?? {};
  const derived = Object.keys(configured).filter((id) => !AUDITED_PROVIDERS.includes(id));
  const providers: ProviderIntegration[] = [];
  for (const provider of [...AUDITED_PROVIDERS, ...derived]) {
    const { base, env } = resolveProvider(provider, configured);
    const platform = Object.hasOwn(SUPPORTED_PLATFORMS, base) ? SUPPORTED_PLATFORMS[base] : null;
    const unsupported = Object.hasOwn(UNSUPPORTED_DETAIL, base) ? UNSUPPORTED_DETAIL[base] : null;
    if (!platform && !unsupported) continue;
    const native =
      platform !== null &&
      settings.autoInject &&
      settings.preferNativeIntegrations &&
      (await nativeIntegrationDetected(
        platform,
        { home, env: { ...hostEnvironment, ...env } },
        dependencies,
      ));
    const activation = !platform || !settings.autoInject ? "disabled" : native ? "native" : "mcp";
    providers.push({
      provider,
      platform,
      activation,
      storageRoot,
      detail: !platform
        ? (unsupported as string)
        : activation === "native"
          ? "Context Mode is already registered natively for this provider, so duplicate MCP injection is disabled. Already-running agents may need a provider refresh or restart to load it."
          : activation === "mcp"
            ? "The bundled Context Mode MCP server is injected only when a new Paseo agent is created. Existing agents keep their saved MCP configuration and must be recreated or configured manually to gain its tools."
            : "Automatic activation is disabled. Existing and new agents keep their current MCP configuration.",
    });
  }
  return {
    runtimePath: runtime.path,
    runtimeVersion: runtime.version,
    injectionEnabled: settings.autoInject,
    providers,
    checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
}

export async function injectContextModeOnCreate<T extends CreateRequest>(
  request: T,
  settings: ContextModeSettings,
  launch: LaunchDescriptor,
  dependencies: IntegrationDependencies = {},
): Promise<T> {
  if (
    !settings.autoInject ||
    request.config.internal ||
    Object.hasOwn(request.config.mcpServers ?? {}, "context-mode")
  ) {
    return request;
  }
  const { base, env } = resolveProvider(request.config.provider, dependencies.providers ?? {});
  if (!Object.hasOwn(SUPPORTED_PLATFORMS, base)) return request;
  const platform = SUPPORTED_PLATFORMS[base];
  if (
    settings.preferNativeIntegrations &&
    (await nativeIntegrationDetected(
      platform,
      {
        home: dependencies.home ?? homedir(),
        cwd: request.config.cwd,
        env: { ...(dependencies.env ?? process.env), ...env, ...request.env },
      },
      dependencies,
    ))
  ) {
    return request;
  }
  const server: McpServer = {
    type: "stdio",
    ...serverArgs(launch, platform),
    // Agents may start with a different environment than this daemon; the panel reads this root.
    env: {
      ...launch.env,
      CONTEXT_MODE_DATA_DIR: resolveContextModeDataDir(
        { ...(dependencies.env ?? process.env), ...env, ...request.env },
        dependencies.home ?? homedir(),
      ),
    },
  };
  return {
    ...request,
    config: {
      ...request.config,
      mcpServers: { ...request.config.mcpServers, "context-mode": server },
    },
  };
}
