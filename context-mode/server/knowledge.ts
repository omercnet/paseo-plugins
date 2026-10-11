import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type {
  ContextModePlatform,
  ContextModeProvider,
  FetchAndIndexInput,
  IndexPathInput,
  KnowledgeToolResult,
  PurgeKnowledgeInput,
  SearchKnowledgeInput,
} from "../shared/knowledge";
import type { ContextModeSettings, contextModeSettings } from "../shared/settings";
import { type BinaryResolution, type LaunchDescriptor, resolveContextModeBinary } from "./binary";
import {
  contextModeStorageRootFor,
  type ProviderConfigSource,
  type ProviderOverrides,
  readProviderOverrides,
  resolveProvider,
} from "./integration";
import {
  type ContextModeToolName,
  callContextModeTool,
  type McpProcessDependencies,
  type McpToolArguments,
} from "./mcp-process";

type SettingsHandle = PluginSettings<typeof contextModeSettings.schema>;

type KnowledgeToolCaller = (
  launch: LaunchDescriptor,
  name: ContextModeToolName,
  arguments_: McpToolArguments,
  dependencies: McpProcessDependencies,
) => Promise<string>;

export interface KnowledgeHandlerDependencies {
  now?: () => Date;
  resolveBinary?: (settings: ContextModeSettings) => Promise<BinaryResolution>;
  callTool?: KnowledgeToolCaller;
}

type KnowledgeContext = { paseo?: ProviderConfigSource };

export interface ContextModeKnowledgeHandlers {
  search(input: SearchKnowledgeInput, context?: KnowledgeContext): Promise<KnowledgeToolResult>;
  indexPath(input: IndexPathInput, context?: KnowledgeContext): Promise<KnowledgeToolResult>;
  fetchAndIndex(
    input: FetchAndIndexInput,
    context?: KnowledgeContext,
  ): Promise<KnowledgeToolResult>;
  purge(input: PurgeKnowledgeInput, context?: KnowledgeContext): Promise<KnowledgeToolResult>;
}

const PROVIDER_PLATFORMS: Readonly<Record<ContextModeProvider, ContextModePlatform>> = {
  claude: "claude-code",
  codex: "codex",
  copilot: "copilot-cli",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  "omp-plugin": "omp",
};

export function contextModePlatformFor(provider: ContextModeProvider): ContextModePlatform {
  return PROVIDER_PLATFORMS[provider];
}

/**
 * `provider` is a Paseo provider id: a built-in, or a configured one whose own `extends` and env
 * decide the storage root (`providers` is `agents.providers`).
 */
export function contextModeEnvironmentFor(
  provider: string,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  providers: ProviderOverrides = {},
): NodeJS.ProcessEnv {
  const { base, policy, env: providerEnv } = resolveProvider(provider, providers);
  const storageRoot = contextModeStorageRootFor(base, { home, env: { ...env, ...providerEnv } });
  if (!policy || !storageRoot)
    throw new Error(`Context Mode does not support provider ${provider}.`);
  return { CONTEXT_MODE_PLATFORM: policy.platform, CONTEXT_MODE_DIR: storageRoot };
}

function definedArguments(values: Record<string, unknown>): McpToolArguments {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as McpToolArguments;
}

export function createContextModeKnowledgeHandlers(
  settingsHandle: SettingsHandle,
  dependencies: KnowledgeHandlerDependencies = {},
): ContextModeKnowledgeHandlers {
  const now = dependencies.now ?? (() => new Date());
  const resolveBinary = dependencies.resolveBinary ?? resolveContextModeBinary;
  const callTool = dependencies.callTool ?? callContextModeTool;

  async function launchDescriptor(): Promise<LaunchDescriptor> {
    const settings = await settingsHandle.read();
    if (settings.status !== "ready") {
      throw new Error(`Context Mode settings are invalid: ${settings.error}`.slice(0, 4_096));
    }
    const binary = await resolveBinary(settings.values);
    if (binary.state === "missing") throw new Error(binary.message.slice(0, 4_096));
    return binary.launch;
  }

  async function run(
    provider: string,
    projectPath: string,
    name: ContextModeToolName,
    arguments_: McpToolArguments,
    context: KnowledgeContext | undefined,
    environmentOverrides: NodeJS.ProcessEnv = {},
  ): Promise<KnowledgeToolResult> {
    const launch = await launchDescriptor();
    const providers = await readProviderOverrides(context?.paseo);
    const output = await callTool(launch, name, arguments_, {
      env: {
        ...contextModeEnvironmentFor(provider, homedir(), process.env, providers),
        ...environmentOverrides,
      },
      cwd: projectPath,
    });
    return { provider, output, completedAt: now().toISOString() };
  }

  return {
    search({ provider, projectPath, queries, limit, source, contentType, sort }, context) {
      return run(
        provider,
        projectPath,
        "ctx_search",
        definedArguments({ queries, limit, source, contentType, sort }),
        context,
      );
    },
    indexPath(
      {
        provider,
        projectPath,
        path,
        source,
        include,
        exclude,
        maxDepth,
        maxFiles,
        extensions,
        respectGitignore,
        followSymlinks,
      },
      context,
    ) {
      if (!isAbsolute(path)) {
        throw new Error("Knowledge indexing requires an absolute path on this host.");
      }
      return run(
        provider,
        projectPath,
        "ctx_index",
        definedArguments({
          path,
          source,
          include,
          exclude,
          maxDepth,
          maxFiles,
          extensions,
          respectGitignore,
          followSymlinks,
        }),
        context,
      );
    },
    fetchAndIndex({ provider, projectPath, url, source, force, ttl }, context) {
      return run(
        provider,
        projectPath,
        "ctx_fetch_and_index",
        definedArguments({ url, source, force, ttl }),
        context,
        { CTX_FETCH_STRICT: "1" },
      );
    },
    async purge(input, context) {
      const raw = input as PurgeKnowledgeInput & { sessionId?: string };
      if (raw.confirm !== true) {
        throw new Error("Purge requires exact confirmation with confirm: true.");
      }
      if (raw.scope === "project") {
        if (raw.sessionId !== undefined) {
          throw new Error("Purge requires exactly one scope.");
        }
        return await run(
          raw.provider,
          raw.projectPath,
          "ctx_purge",
          { confirm: true, scope: "project" },
          context,
        );
      }
      if (raw.scope !== "session" || !raw.sessionId) {
        throw new Error("Session purge requires exactly one non-empty sessionId scope.");
      }
      return await run(
        raw.provider,
        raw.projectPath,
        "ctx_purge",
        { confirm: true, scope: "session", sessionId: raw.sessionId },
        context,
      );
    },
  };
}
