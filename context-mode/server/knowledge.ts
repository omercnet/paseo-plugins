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
import { contextModeStorageRootFor } from "./integration";
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

export interface ContextModeKnowledgeHandlers {
  search(input: SearchKnowledgeInput): Promise<KnowledgeToolResult>;
  indexPath(input: IndexPathInput): Promise<KnowledgeToolResult>;
  fetchAndIndex(input: FetchAndIndexInput): Promise<KnowledgeToolResult>;
  purge(input: PurgeKnowledgeInput): Promise<KnowledgeToolResult>;
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

export function contextModeEnvironmentFor(
  provider: ContextModeProvider,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const storageRoot = contextModeStorageRootFor(provider, { home, env });
  if (!storageRoot) throw new Error(`Context Mode does not support provider ${provider}.`);
  return {
    CONTEXT_MODE_PLATFORM: contextModePlatformFor(provider),
    CONTEXT_MODE_DIR: storageRoot,
  };
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
    provider: ContextModeProvider,
    projectPath: string,
    name: ContextModeToolName,
    arguments_: McpToolArguments,
    environmentOverrides: NodeJS.ProcessEnv = {},
  ): Promise<KnowledgeToolResult> {
    const launch = await launchDescriptor();
    const output = await callTool(launch, name, arguments_, {
      env: { ...contextModeEnvironmentFor(provider), ...environmentOverrides },
      cwd: projectPath,
    });
    return { provider, output, completedAt: now().toISOString() };
  }

  return {
    search({ provider, projectPath, queries, limit, source, contentType, sort }) {
      return run(
        provider,
        projectPath,
        "ctx_search",
        definedArguments({ queries, limit, source, contentType, sort }),
      );
    },
    indexPath({
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
    }) {
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
      );
    },
    fetchAndIndex({ provider, projectPath, url, source, force, ttl }) {
      return run(
        provider,
        projectPath,
        "ctx_fetch_and_index",
        definedArguments({ url, source, force, ttl }),
        { CTX_FETCH_STRICT: "1" },
      );
    },
    async purge(input) {
      const raw = input as PurgeKnowledgeInput & { sessionId?: string };
      if (raw.confirm !== true) {
        throw new Error("Purge requires exact confirmation with confirm: true.");
      }
      if (raw.scope === "project") {
        if (raw.sessionId !== undefined) {
          throw new Error("Purge requires exactly one scope.");
        }
        return await run(raw.provider, raw.projectPath, "ctx_purge", {
          confirm: true,
          scope: "project",
        });
      }
      if (raw.scope !== "session" || !raw.sessionId) {
        throw new Error("Session purge requires exactly one non-empty sessionId scope.");
      }
      return await run(raw.provider, raw.projectPath, "ctx_purge", {
        confirm: true,
        scope: "session",
        sessionId: raw.sessionId,
      });
    },
  };
}
