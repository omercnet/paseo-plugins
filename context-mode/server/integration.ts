import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IntegrationAudit, ProviderIntegration } from "../shared/contracts";
import {
  CONTEXT_MODE_PROVIDERS,
  type ContextModePlatform,
  ContextModeProviderSchema,
  contextModePlatformFor,
} from "../shared/providers";
import type { ContextModeSettings } from "../shared/settings";
import type { LaunchDescriptor } from "./binary";
import { serverArgs } from "./mcp-process";
import { resolveContextModeDataDir } from "./storage-discovery";

const AUDITED_PROVIDERS = [
  ...CONTEXT_MODE_PROVIDERS.map(({ provider }) => provider),
  "cursor",
  "pi",
  "omp",
  "omp-plugin",
];

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
 * effective env is the parent's override env overlaid with its own. `platform` is null when
 * Context Mode 2 cannot serve the provider over MCP.
 */
export function resolveProvider(
  id: string,
  providers: ProviderOverrides,
): { base: string; platform: ContextModePlatform | null; env: Record<string, string> } {
  const own = Object.hasOwn(providers, id) ? providers[id] : undefined;
  const parent = own?.extends ?? id;
  const inherited =
    parent !== id && Object.hasOwn(providers, parent) ? providers[parent] : undefined;
  const base = parent.startsWith("omp-plugin-") ? "omp-plugin" : parent;
  const supported = ContextModeProviderSchema.safeParse(base);
  const platform = supported.success ? contextModePlatformFor(supported.data) : null;
  return { base, platform, env: { ...inherited?.env, ...own?.env } };
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

/** Scan results per (path, marker); audit polls and agent creation repeat the same probes. */
const fileScans = new Map<string, { mtimeMs: number; size: number; found: boolean }>();

/** Streams the file, so a large `~/.claude.json` is still searched without loading it whole. */
async function defaultFileContains(path: string, text: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return false;
    const { mtimeMs, size } = metadata;
    const key = `${path}\0${text}`;
    const cached = fileScans.get(key);
    if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.found;
    let found = false;
    let tail = "";
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
      const window = tail + chunk;
      if (window.includes(text)) {
        found = true;
        break;
      }
      tail = window.slice(window.length - text.length + 1);
    }
    fileScans.set(key, { mtimeMs, size, found });
    return found;
  } catch {
    return false;
  }
}

async function anyProbeMatches(
  probes: readonly NativeProbe[],
  dependencies: IntegrationDependencies,
): Promise<boolean> {
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const fileContains = dependencies.fileContains ?? defaultFileContains;
  for (const probe of probes) {
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

function nativeIntegrationDetected(
  platform: ContextModePlatform,
  context: ProbeContext,
  dependencies: IntegrationDependencies,
): Promise<boolean> {
  return anyProbeMatches(nativeProbes(platform, context), dependencies);
}

/** Providers Paseo cannot inject: their own Context Mode install is reported, nothing more. */
interface HostOnlyPolicy {
  probes(context: ProbeContext): NativeProbe[];
  installed: string;
  missing: string;
}

function piProbes({ home, cwd, env }: ProbeContext): NativeProbe[] {
  // `pi install npm:context-mode` lists the package in Pi's settings, user or project level.
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const probes: NativeProbe[] = [
    { kind: "file", path: join(agentDir, "settings.json"), marker: "context-mode" },
  ];
  if (cwd)
    probes.push({ kind: "file", path: join(cwd, ".pi", "settings.json"), marker: "context-mode" });
  return probes;
}

function ompProbes({ home, cwd, env }: ProbeContext): NativeProbe[] {
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".omp", "agent");
  const probes: NativeProbe[] = [
    { kind: "file", path: join(agentDir, "mcp.json"), marker: '"context-mode"' },
  ];
  if (cwd)
    probes.push({ kind: "file", path: join(cwd, ".omp", "mcp.json"), marker: '"context-mode"' });
  return probes;
}

const OMP_POLICY: HostOnlyPolicy = {
  probes: ompProbes,
  installed:
    "OMP loads its own Context Mode server from its MCP config, so Paseo injects nothing. Context Mode 2 has no OMP integration (upstream keeps OMP on 1.0.169), so OMP's sessions are not shown here.",
  missing:
    "Context Mode 2 has no OMP integration, so Paseo injects nothing. Upstream keeps OMP on Context Mode 1.0.169, installed through OMP's own plugins.",
};

const HOST_ONLY: Readonly<Record<string, HostOnlyPolicy>> = {
  pi: {
    probes: piProbes,
    installed:
      "Context Mode runs inside Pi as its own extension, so Paseo injects nothing. Pi records its sessions in the shared store, so they appear in Savings.",
    missing:
      "Context Mode 2 runs inside Pi only as an extension, so Paseo cannot inject it. Install it in Pi with `pi install npm:context-mode`.",
  },
  omp: OMP_POLICY,
  "omp-plugin": OMP_POLICY,
};

const UNSUPPORTED_DETAIL: Readonly<Record<string, string>> = {
  cursor: "Context Mode 2 dropped Cursor, so nothing is injected.",
};

async function hostOnlyIntegration(
  base: string,
  context: ProbeContext,
  dependencies: IntegrationDependencies,
): Promise<Pick<ProviderIntegration, "activation" | "detail"> | null> {
  if (Object.hasOwn(HOST_ONLY, base)) {
    const policy = HOST_ONLY[base];
    const installed = await anyProbeMatches(policy.probes(context), dependencies);
    return installed
      ? { activation: "native", detail: policy.installed }
      : { activation: "disabled", detail: policy.missing };
  }
  if (Object.hasOwn(UNSUPPORTED_DETAIL, base)) {
    return { activation: "disabled", detail: UNSUPPORTED_DETAIL[base] };
  }
  return null;
}

const ACTIVATION_DETAIL: Readonly<Record<ProviderIntegration["activation"], string>> = {
  native:
    "Context Mode is already registered natively for this provider, so duplicate MCP injection is disabled. Already-running agents may need a provider refresh or restart to load it.",
  mcp: "The Context Mode MCP server is injected only when a new Paseo agent is created. Existing agents keep their saved MCP configuration and must be recreated or configured manually to gain its tools.",
  disabled:
    "Automatic activation is disabled. Existing and new agents keep their current MCP configuration.",
};

export async function createIntegrationAudit(
  settings: ContextModeSettings,
  dependencies: IntegrationDependencies = {},
): Promise<IntegrationAudit> {
  const home = dependencies.home ?? homedir();
  const hostEnvironment = dependencies.env ?? process.env;
  const configured = dependencies.providers ?? {};
  const derived = Object.keys(configured).filter((id) => !AUDITED_PROVIDERS.includes(id));
  const providers: ProviderIntegration[] = [];
  for (const provider of [...AUDITED_PROVIDERS, ...derived]) {
    const { base, platform, env } = resolveProvider(provider, configured);
    if (platform === null) {
      const row = await hostOnlyIntegration(
        base,
        { home, env: { ...hostEnvironment, ...env } },
        dependencies,
      );
      if (row) providers.push({ provider, platform, ...row });
      continue;
    }
    const nativeChecked = settings.autoInject && settings.preferNativeIntegrations;
    const native =
      nativeChecked &&
      (await nativeIntegrationDetected(
        platform,
        { home, env: { ...hostEnvironment, ...env } },
        dependencies,
      ));
    let activation: ProviderIntegration["activation"] = "disabled";
    if (settings.autoInject) activation = native ? "native" : "mcp";
    providers.push({ provider, platform, activation, detail: ACTIVATION_DETAIL[activation] });
  }
  return { providers };
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
  const { platform, env } = resolveProvider(request.config.provider, dependencies.providers ?? {});
  if (platform === null) return request;
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
    // Agents may start with a different environment than this daemon. Pin the host or provider
    // store, never a per-request one, so the dashboard, Resume and Forget reach what agents write.
    env: {
      ...launch.env,
      CONTEXT_MODE_DATA_DIR: resolveContextModeDataDir(
        { ...(dependencies.env ?? process.env), ...env },
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
