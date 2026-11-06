import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import {
  type ContextModePlatform,
  type ContextModeProvider,
  ContextModeProviderSchema,
  type FetchAndIndexInput,
  type IndexPathInput,
  type KnowledgeToolResult,
  type PurgeKnowledgeInput,
  type ResumeSessionInput,
  type SearchKnowledgeInput,
  type SearchKnowledgeResult,
  type SearchPage,
} from "../shared/knowledge";
import type { contextModeSettings } from "../shared/settings";
import { type LaunchDescriptor, resolveContextModeBinary } from "./binary";
import { type ProviderConfigSource, readProviderOverrides } from "./integration";
import {
  type ContextModeToolName,
  callContextModeTool,
  type McpToolArguments,
} from "./mcp-process";
import { resolveContextModeDataDir } from "./storage-discovery";

type SettingsHandle = PluginSettings<typeof contextModeSettings.schema>;

export interface KnowledgeHandlerDependencies {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  home?: string;
  resolveBinary?: typeof resolveContextModeBinary;
  callTool?: typeof callContextModeTool;
}

type KnowledgeContext = { paseo?: ProviderConfigSource };

export interface ContextModeKnowledgeHandlers {
  search(input: SearchKnowledgeInput, context?: KnowledgeContext): Promise<SearchKnowledgeResult>;
  resume(input: ResumeSessionInput, context?: KnowledgeContext): Promise<KnowledgeToolResult>;
  indexPath(input: IndexPathInput, context?: KnowledgeContext): Promise<KnowledgeToolResult>;
  fetchAndIndex(
    input: FetchAndIndexInput,
    context?: KnowledgeContext,
  ): Promise<KnowledgeToolResult>;
  purge(input: PurgeKnowledgeInput, context?: KnowledgeContext): Promise<KnowledgeToolResult>;
}

/** Search replies end with `More: ctx_search({..., offset:N})`, or `more: ... after:MS` for timeline. */
const NEXT_PAGE_LINE = /^[Mm]ore: ctx_search\(\{.*\b(offset|after):(\d+)\}\)\s*$/gm;

/** The cursor of the last footer; the UI searches one query at a time, so there is one. */
function nextSearchPage(output: string): SearchPage | null {
  const last = [...output.matchAll(NEXT_PAGE_LINE)].at(-1);
  if (!last) return null;
  const cursor = Number(last[2]);
  return last[1] === "after" ? { after: cursor } : { offset: cursor };
}

function purgeArguments(input: PurgeKnowledgeInput): McpToolArguments {
  switch (input.scope) {
    case "project":
      return { project: true };
    case "session":
      return { session: input.sessionId };
    case "source":
      return { source: input.source };
  }
}

const PROVIDER_PLATFORMS: Readonly<Record<ContextModeProvider, ContextModePlatform>> = {
  claude: "claude-code",
  codex: "codex",
  copilot: "copilot-cli",
  opencode: "opencode",
};

export function contextModePlatformFor(provider: ContextModeProvider): ContextModePlatform {
  return PROVIDER_PLATFORMS[provider];
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
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const resolveBinary = dependencies.resolveBinary ?? resolveContextModeBinary;
  const callTool = dependencies.callTool ?? callContextModeTool;

  async function launchDescriptor(
    paseo: ProviderConfigSource | undefined,
  ): Promise<LaunchDescriptor> {
    const settings = await settingsHandle.read();
    if (settings.status !== "ready") {
      throw new Error(`Context Mode settings are invalid: ${settings.error}`.slice(0, 4_096));
    }
    const binary = await resolveBinary(settings.values, { paseo });
    if (binary.state === "missing") throw new Error(binary.message.slice(0, 4_096));
    return binary.launch;
  }

  async function run(
    provider: string,
    projectPath: string,
    name: ContextModeToolName,
    arguments_: McpToolArguments,
    context: KnowledgeContext | undefined,
  ): Promise<KnowledgeToolResult> {
    // A configured provider inherits its parent's agent id; its own env may move the data dir.
    const overrides = await readProviderOverrides(context?.paseo);
    const own = Object.hasOwn(overrides, provider) ? overrides[provider] : undefined;
    const base = ContextModeProviderSchema.safeParse(own?.extends ?? provider);
    if (!base.success) throw new Error(`Context Mode does not support provider ${provider}.`);
    const parent =
      own?.extends && Object.hasOwn(overrides, own.extends) ? overrides[own.extends] : undefined;
    const launch = await launchDescriptor(context?.paseo);
    const output = await callTool(
      launch,
      name,
      arguments_,
      {},
      {
        platform: PROVIDER_PLATFORMS[base.data],
        cwd: projectPath,
        dataDir: resolveContextModeDataDir({ ...env, ...parent?.env, ...own?.env }, home),
      },
    );
    return { provider, output, completedAt: now().toISOString() };
  }

  return {
    async search({ provider, projectPath, queries, scope, source, sort, page }, context) {
      const result = await run(
        provider,
        projectPath,
        "ctx_search",
        definedArguments({ queries, scope, source, sort, ...page }),
        context,
      );
      return { ...result, next: nextSearchPage(result.output) };
    },
    resume({ provider, projectPath, sessionId }, context) {
      return run(provider, projectPath, "ctx_resume", { session: sessionId }, context);
    },
    indexPath({ provider, projectPath, path }, context) {
      if (!isAbsolute(path)) {
        throw new Error("Knowledge indexing requires an absolute path on this host.");
      }
      return run(provider, projectPath, "ctx_index", { path }, context);
    },
    fetchAndIndex({ provider, projectPath, url }, context) {
      return run(provider, projectPath, "ctx_index", { url }, context);
    },
    purge(input, context) {
      return run(input.provider, input.projectPath, "ctx_purge", purgeArguments(input), context);
    },
  };
}
