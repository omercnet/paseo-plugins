import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ContextModeSettings, IntegrationAudit, ProviderIntegration } from "../shared";
import type { LaunchDescriptor } from "./binary";

const AUDITED_PROVIDERS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "opencode",
  "pi",
  "omp",
  "omp-plugin",
] as const;

type AuditedProvider = (typeof AUDITED_PROVIDERS)[number];
type ContextModePlatform =
  | "claude-code"
  | "codex"
  | "copilot-cli"
  | "cursor"
  | "opencode"
  | "pi"
  | "omp";

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

type SessionOpenRequest = {
  provider: string;
  cwd?: string;
  env: Readonly<Record<string, string>>;
};

export interface IntegrationDependencies {
  home?: string;
  pathExists?: (path: string) => Promise<boolean>;
  fileContains?: (path: string, text: string) => Promise<boolean>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface ContextModeStorageOptions {
  home?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

type ProviderContext = {
  home: string;
  cwd?: string;
  env: Readonly<Record<string, string | undefined>>;
};

type NativeProbe = { kind: "path"; path: string } | { kind: "file"; path: string; marker: string };

type ProviderPolicy = {
  platform: ContextModePlatform;
  storageRoot: (context: ProviderContext) => string;
  nativeProbes: (context: ProviderContext) => readonly NativeProbe[];
};

function configuredRoot(
  value: string | undefined,
  fallback: string,
  { home, cwd }: Pick<ProviderContext, "home" | "cwd">,
): string {
  const candidate = value?.trim();
  if (!candidate) return fallback;
  if (candidate === "~") return home;
  if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    return join(home, candidate.slice(2));
  }
  return isAbsolute(candidate) ? candidate : resolve(cwd ?? home, candidate);
}

function claudeRoot(context: ProviderContext): string {
  return configuredRoot(context.env.CLAUDE_CONFIG_DIR, join(context.home, ".claude"), context);
}

function codexRoot(context: ProviderContext): string {
  return configuredRoot(context.env.CODEX_HOME, join(context.home, ".codex"), context);
}

function copilotRoot(context: ProviderContext): string {
  return configuredRoot(context.env.COPILOT_HOME, join(context.home, ".copilot"), context);
}

function opencodeRoot(context: ProviderContext): string {
  const configHome = configuredRoot(
    context.env.XDG_CONFIG_HOME,
    join(context.home, ".config"),
    context,
  );
  return join(configHome, "opencode");
}

function ompAgentRoot(context: ProviderContext): string {
  return configuredRoot(
    context.env.PI_CODING_AGENT_DIR,
    join(context.home, ".omp", "agent"),
    context,
  );
}

function projectProbe(context: ProviderContext, ...segments: string[]): NativeProbe[] {
  return context.cwd
    ? [{ kind: "file", path: join(context.cwd, ...segments), marker: "context-mode" }]
    : [];
}

const OMP_POLICY: ProviderPolicy = {
  platform: "omp",
  storageRoot: ({ home }) => join(home, ".omp", "context-mode"),
  nativeProbes: (context) => [
    ...projectProbe(context, ".omp", "mcp.json"),
    { kind: "file", path: join(ompAgentRoot(context), "mcp.json"), marker: "context-mode" },
    {
      kind: "file",
      path: join(context.home, ".omp", "plugins", "package.json"),
      marker: '"context-mode"',
    },
    { kind: "path", path: join(context.home, ".omp", "plugins", "node_modules", "context-mode") },
  ],
};

const PROVIDER_POLICIES: Readonly<Record<Exclude<AuditedProvider, "omp-plugin">, ProviderPolicy>> =
  {
    claude: {
      platform: "claude-code",
      storageRoot: (context) => join(claudeRoot(context), "context-mode"),
      nativeProbes: (context) => [
        {
          kind: "file",
          path: join(claudeRoot(context), "settings.json"),
          marker: "context-mode",
        },
        { kind: "file", path: join(context.home, ".claude.json"), marker: "context-mode" },
        {
          kind: "file",
          path: join(claudeRoot(context), "plugins", "installed_plugins.json"),
          marker: "context-mode",
        },
        { kind: "path", path: join(claudeRoot(context), "plugins", "cache", "context-mode") },
      ],
    },
    codex: {
      platform: "codex",
      storageRoot: (context) => join(codexRoot(context), "context-mode"),
      nativeProbes: (context) => {
        const configPath = join(codexRoot(context), "config.toml");
        return [
          { kind: "file", path: configPath, marker: '[plugins."context-mode@context-mode"]' },
          { kind: "file", path: configPath, marker: "[mcp_servers.context-mode]" },
        ];
      },
    },
    copilot: {
      platform: "copilot-cli",
      storageRoot: (context) => join(copilotRoot(context), "context-mode"),
      nativeProbes: (context) => [
        {
          kind: "file",
          path: join(copilotRoot(context), "mcp-config.json"),
          marker: "context-mode",
        },
      ],
    },
    cursor: {
      platform: "cursor",
      storageRoot: ({ home }) => join(home, ".cursor", "context-mode"),
      nativeProbes: (context) => [
        ...projectProbe(context, ".cursor", "mcp.json"),
        {
          kind: "file",
          path: join(context.home, ".cursor", "mcp.json"),
          marker: "context-mode",
        },
        {
          kind: "path",
          path: join(context.home, ".cursor", "plugins", "local", "context-mode"),
        },
      ],
    },
    opencode: {
      platform: "opencode",
      storageRoot: (context) => join(opencodeRoot(context), "context-mode"),
      nativeProbes: (context) => [
        ...(context.cwd
          ? [
              "opencode.jsonc",
              "opencode.json",
              join(".opencode", "opencode.jsonc"),
              join(".opencode", "opencode.json"),
            ].map(
              (path): NativeProbe => ({
                kind: "file",
                path: join(context.cwd as string, path),
                marker: "context-mode",
              }),
            )
          : []),
        {
          kind: "file",
          path: join(opencodeRoot(context), "opencode.jsonc"),
          marker: "context-mode",
        },
        {
          kind: "file",
          path: join(opencodeRoot(context), "opencode.json"),
          marker: "context-mode",
        },
      ],
    },
    pi: {
      platform: "pi",
      storageRoot: ({ home }) => join(home, ".pi", "context-mode"),
      nativeProbes: ({ home }) => [
        { kind: "file", path: join(home, ".pi", "agent", "settings.json"), marker: "context-mode" },
        { kind: "path", path: join(home, ".pi", "extensions", "context-mode", "package.json") },
      ],
    },
    omp: OMP_POLICY,
  };

function providerPolicy(provider: string): ProviderPolicy | null {
  if (provider === "omp-plugin" || provider.startsWith("omp-plugin-")) return OMP_POLICY;
  return PROVIDER_POLICIES[provider as keyof typeof PROVIDER_POLICIES] ?? null;
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
  policy: ProviderPolicy,
  context: ProviderContext,
  pathExists: (path: string) => Promise<boolean>,
  fileContains: (path: string, text: string) => Promise<boolean>,
): Promise<boolean> {
  for (const probe of policy.nativeProbes(context)) {
    if (probe.kind === "path") {
      if (await pathExists(probe.path)) return true;
    } else if (await fileContains(probe.path, probe.marker)) {
      return true;
    }
  }
  return false;
}

function serverEnvironment(
  policy: ProviderPolicy,
  storageRoot: string,
  explicitEnvironment: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    CONTEXT_MODE_PLATFORM: explicitEnvironment.CONTEXT_MODE_PLATFORM ?? policy.platform,
    CONTEXT_MODE_DIR: explicitEnvironment.CONTEXT_MODE_DIR ?? storageRoot,
  };
}

function providerContext(
  home: string,
  cwd: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): ProviderContext {
  return { home, cwd, env: env ?? {} };
}

export function contextModeStorageRootFor(
  provider: string,
  options: ContextModeStorageOptions = {},
): string | null {
  const policy = providerPolicy(provider);
  if (!policy) return null;
  const home = options.home ?? homedir();
  const context = providerContext(home, options.cwd, options.env);
  const explicitRoot = options.env?.CONTEXT_MODE_DIR?.trim();
  if (explicitRoot && isAbsolute(explicitRoot)) return resolve(explicitRoot);
  const dataRoot = options.env?.CONTEXT_MODE_DATA_DIR?.trim();
  if (dataRoot && isAbsolute(dataRoot)) return join(resolve(dataRoot), "context-mode");
  return policy.storageRoot(context);
}

export async function createIntegrationAudit(
  settings: ContextModeSettings,
  runtime: { path: string; version: string | null },
  dependencies: IntegrationDependencies = {},
): Promise<IntegrationAudit> {
  const home = dependencies.home ?? homedir();
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const fileContains = dependencies.fileContains ?? defaultFileContains;
  const hostEnvironment = dependencies.env ?? process.env;
  const context = providerContext(home, undefined, hostEnvironment);
  const nativeByPolicy = new Map<ProviderPolicy, Promise<boolean>>();
  const detectNative = (policy: ProviderPolicy) => {
    const existing = nativeByPolicy.get(policy);
    if (existing) return existing;
    const detected = nativeIntegrationDetected(policy, context, pathExists, fileContains);
    nativeByPolicy.set(policy, detected);
    return detected;
  };
  const providers: ProviderIntegration[] = [];
  for (const provider of AUDITED_PROVIDERS) {
    const policy = providerPolicy(provider);
    if (!policy) continue;
    const storageRoot = contextModeStorageRootFor(provider, { home, env: hostEnvironment });
    if (!storageRoot) continue;
    const reusesExistingStorage = await pathExists(storageRoot);
    const native =
      settings.autoInject && settings.preferNativeIntegrations && (await detectNative(policy));
    const activation = !settings.autoInject ? "disabled" : native ? "native" : "mcp";
    providers.push({
      provider,
      platform: policy.platform,
      activation,
      storageRoot,
      reusesExistingStorage,
      detail:
        activation === "native"
          ? "An existing native Context Mode registration was found in an authoritative provider config location, so duplicate MCP injection is disabled. Already-running agents may need a provider refresh or restart to load it."
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
  const policy = providerPolicy(request.config.provider);
  if (!policy) return request;
  const home = dependencies.home ?? homedir();
  const hostEnvironment = dependencies.env ?? process.env;
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const fileContains = dependencies.fileContains ?? defaultFileContains;
  const context = providerContext(home, request.config.cwd, {
    ...hostEnvironment,
    ...request.env,
  });
  if (
    settings.preferNativeIntegrations &&
    (await nativeIntegrationDetected(policy, context, pathExists, fileContains))
  ) {
    return request;
  }
  const storageRoot = contextModeStorageRootFor(request.config.provider, {
    home,
    cwd: request.config.cwd,
    env: { ...hostEnvironment, ...request.env },
  });
  if (!storageRoot) return request;
  const env = serverEnvironment(policy, storageRoot, request.env);
  const server: McpServer = {
    type: "stdio",
    command: launch.program,
    args: launch.args,
    env,
  };
  return {
    ...request,
    config: {
      ...request.config,
      mcpServers: { ...request.config.mcpServers, "context-mode": server },
    },
  };
}

export async function injectContextModeEnvironment<T extends SessionOpenRequest>(
  request: T,
  settings: ContextModeSettings,
  dependencies: IntegrationDependencies = {},
): Promise<T> {
  if (!settings.autoInject) return request;
  const policy = providerPolicy(request.provider);
  if (!policy) return request;
  const home = dependencies.home ?? homedir();
  const hostEnvironment = dependencies.env ?? process.env;
  const storageRoot = contextModeStorageRootFor(request.provider, {
    home,
    cwd: request.cwd,
    env: { ...hostEnvironment, ...request.env },
  });
  if (!storageRoot) return request;
  return {
    ...request,
    env: {
      ...serverEnvironment(policy, storageRoot),
      ...request.env,
    },
  };
}
