import { isAbsolute } from "node:path";
import {
  MAX_MODEL_SELECTOR_BYTES,
  MAX_PATH_LENGTH,
  MAX_SYSTEM_PROMPT_LENGTH,
  OmpThinkingLevelSchema,
  validateBoundedText,
} from "./omp-rpc-values";
import { OmpPublicError, utf8Bytes } from "./security";
import { validateNativeSessionId } from "./session-descriptors";
import type { OmpOutputRedaction } from "./settings";

const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_LENGTH = 64 * 1024;
const MAX_ENV_TOTAL_LENGTH = 1024 * 1024;

export interface OmpStartOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  outputRedaction?: OmpOutputRedaction;
  inheritEnv?: readonly string[];
  /** Server-owned environment source; tests provide isolated roots instead of ambient process.env. */
  environment?: NodeJS.ProcessEnv;
  command?: readonly string[];
  model?: string;
  mode?: "full" | "write" | "ask";
  thinkingOption?: string;
  systemPrompt?: string;
  roleModels?: Readonly<{ smol?: string; slow?: string; plan?: string }>;
  tools?: readonly string[];
  sessionDir?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Resume this exact native OMP session; never use this to start a new conversation. */
  resumeSessionId?: string;
  noSession?: boolean;
  signal?: AbortSignal;
}

export interface OmpSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  inheritedRedactionValues: string[];
}

// The daemon contributes only process/runtime discovery variables plus provider authentication
// families. Session-scoped values are explicit host input and are overlaid after rejecting loader
// and executable-resolution controls; this keeps provider credentials available without copying
const INHERITED_RUNTIME_ENV: Readonly<Record<string, true>> = {
  ALL_PROXY: true,
  APPDATA: true,
  COLORTERM: true,
  HOME: true,
  HTTPS_PROXY: true,
  HTTP_PROXY: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  LOCALAPPDATA: true,
  LOGNAME: true,
  NO_PROXY: true,
  OMP_PROFILE: true,
  PATH: true,
  PATHEXT: true,
  PI_CODING_AGENT_DIR: true,
  PI_CONFIG_DIR: true,
  PI_PROFILE: true,
  SHELL: true,
  SSH_AUTH_SOCK: true,
  SSL_CERT_DIR: true,
  SSL_CERT_FILE: true,
  SYSTEMROOT: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  TZ: true,
  USER: true,
  USERPROFILE: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  XDG_RUNTIME_DIR: true,
};
const INHERITED_PROVIDER_AUTH_ENV: Readonly<Record<string, true>> = {
  AI_GATEWAY_API_KEY: true,
  AIAND_API_KEY: true,
  ALIBABA_CODING_PLAN_API_KEY: true,
  ALIBABA_TOKEN_PLAN_API_KEY: true,
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_FOUNDRY_API_KEY: true,
  ANTHROPIC_OAUTH_TOKEN: true,
  AWS_ACCESS_KEY_ID: true,
  AWS_DEFAULT_REGION: true,
  AWS_PROFILE: true,
  AWS_REGION: true,
  AWS_SECRET_ACCESS_KEY: true,
  AWS_SESSION_TOKEN: true,
  AZURE_CLIENT_ID: true,
  AZURE_CLIENT_SECRET: true,
  AZURE_OPENAI_API_KEY: true,
  AZURE_OPENAI_ENDPOINT: true,
  AZURE_TENANT_ID: true,
  BAILIAN_TOKEN_PLAN_API_KEY: true,
  BASETEN_API_KEY: true,
  CEREBRAS_API_KEY: true,
  CHARM_HYPER_API_KEY: true,
  CLINE_API_KEY: true,
  CLOUDFLARE_AI_GATEWAY_API_KEY: true,
  COHERE_API_KEY: true,
  COMMAND_CODE_API_KEY: true,
  COREWEAVE_API_KEY: true,
  CURSOR_ACCESS_TOKEN: true,
  DEEPINFRA_API_KEY: true,
  DEEPSEEK_API_KEY: true,
  DEVIN_API_KEY: true,
  FIREPASS_API_KEY: true,
  FIREWORKS_API_KEY: true,
  FUGU_API_KEY: true,
  GEMINI_API_KEY: true,
  GMI_API_KEY: true,
  GOOGLE_API_KEY: true,
  GOOGLE_APPLICATION_CREDENTIALS: true,
  GROQ_API_KEY: true,
  HF_TOKEN: true,
  HUGGINGFACE_HUB_TOKEN: true,
  LLAMA_CPP_API_KEY: true,
  LM_STUDIO_API_KEY: true,
  META_API_KEY: true,
  MINIMAX_API_KEY: true,
  MINIMAX_CODE_API_KEY: true,
  MINIMAX_CODE_CN_API_KEY: true,
  MISTRAL_API_KEY: true,
  MODEL_API_KEY: true,
  MOONSHOT_API_KEY: true,
  NANO_GPT_API_KEY: true,
  NVIDIA_API_KEY: true,
  NOVITA_API_KEY: true,
  OLLAMA_API_KEY: true,
  OLLAMA_CLOUD_API_KEY: true,
  OLLAMA_HOST: true,
  OMP_AUTH_BROKER_TOKEN: true,
  OMP_AUTH_BROKER_URL: true,
  OPENCODE_API_KEY: true,
  OPENAI_API_KEY: true,
  OPENAI_CODEX_OAUTH_TOKEN: true,
  OPENROUTER_API_KEY: true,
  PLEXUS_API_KEY: true,
  QIANFAN_API_KEY: true,
  QWEN_OAUTH_TOKEN: true,
  QWEN_PORTAL_API_KEY: true,
  SAKANA_API_KEY: true,
  SILICONFLOW_API_KEY: true,
  SILICONFLOW_CN_API_KEY: true,
  SYNTHETIC_API_KEY: true,
  TOGETHER_API_KEY: true,
  UMANS_AI_CODING_PLAN_API_KEY: true,
  VENICE_API_KEY: true,
  VLLM_API_KEY: true,
  WAFER_SERVERLESS_API_KEY: true,
  WANDB_API_KEY: true,
  XAI_API_KEY: true,
  XAI_OAUTH_TOKEN: true,
  XIAOMI_API_KEY: true,
  XIAOMI_TOKEN_PLAN_AMS_API_KEY: true,
  XIAOMI_TOKEN_PLAN_CN_API_KEY: true,
  XIAOMI_TOKEN_PLAN_SGP_API_KEY: true,
  YOLO_AUTO_API_KEY: true,
  ZAI_API_KEY: true,
  ZENMUX_API_KEY: true,
  ZHIPU_API_KEY: true,
};
const BLOCKED_SESSION_ENV =
  /^(?:BASH_ENV|BUN_INSTALL.*|BUN_OPTIONS|CLASSPATH|CLAUDE_BASH_NO_CI|CLAUDE_BASH_NO_LOGIN|CLAUDE_CODE_SHELL_PREFIX|DYLD_.*|EDITOR|ELECTRON_RUN_AS_NODE|ENV|GEM_HOME|GEM_PATH|GIT_CONFIG.*|GIT_SSH_COMMAND|HOME|JAVA_TOOL_OPTIONS|LD_.*|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_.*|OMP_AUTORESEARCH_DB_DIR|OMP_COMMAND|OMP_GITHUB_CACHE_DB|OMP_PROFILE|OMP_WORKTREE_DIR|PATH|PATHEXT|PERL5LIB|PERL5OPT|PI_BASH_NO_CI|PI_BASH_NO_LOGIN|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_CONFIG_DIR|PI_CONFIG_FILES|PI_GIT_COMMON_DIR|PI_PACKAGE_DIR|PI_PROFILE|PI_PROJECT_DIR|PI_SESSION_ID|PI_SHELL_PREFIX|PI_SUBPROCESS_CMD|PI_WORKTREE_DIR|PWD|PYTHONHOME|PYTHONINSPECT|PYTHONPATH|PYTHONSTARTUP|RUBYLIB|RUBYOPT|SHELL|SYSTEMROOT|USERPROFILE|VISUAL|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|XDG_STATE_HOME|_JAVA_OPTIONS)$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

function inheritedEnvironmentNames(inheritEnv: readonly string[] | undefined): ReadonlySet<string> {
  if (inheritEnv === undefined) return new Set();
  if (!Array.isArray(inheritEnv)) {
    throw new Error("OMP inherited environment names are invalid");
  }
  if (inheritEnv.length > MAX_ENV_ENTRIES) {
    throw new Error("OMP inherited environment has too many entries");
  }
  const names = new Set<string>();
  for (const name of inheritEnv) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      throw new Error("OMP inherited environment contains an invalid name");
    }
    if (BLOCKED_SESSION_ENV.test(name.toUpperCase())) {
      throw new Error("OMP inherited environment contains a forbidden variable");
    }
    names.add(name);
  }
  return names;
}

function buildOmpEnvironment(
  sessionEnv: Readonly<Record<string, string>> | undefined,
  inheritEnv: readonly string[] | undefined,
  sourceEnv: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; inheritedRedactionValues: string[] } {
  if (
    sessionEnv !== undefined &&
    (sessionEnv === null || typeof sessionEnv !== "object" || Array.isArray(sessionEnv))
  ) {
    throw new Error("OMP session environment is invalid");
  }
  const explicitlyInherited = inheritedEnvironmentNames(inheritEnv);
  const explicitlyInheritedNormalized = new Set(
    [...explicitlyInherited].map((name) => name.toUpperCase()),
  );
  const explicitNames = new Set(Object.keys(sessionEnv ?? {}).map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  const inheritedRedactionValues: string[] = [];
  let totalBytes = 0;
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value === undefined || name.toUpperCase() === "OMP_COMMAND") continue;
    const normalizedName = name.toUpperCase();
    const isRuntime =
      process.platform === "win32"
        ? normalizedName in INHERITED_RUNTIME_ENV
        : name in INHERITED_RUNTIME_ENV;
    const isProviderAuth =
      process.platform === "win32"
        ? normalizedName in INHERITED_PROVIDER_AUTH_ENV
        : name in INHERITED_PROVIDER_AUTH_ENV;
    const isExplicitlyInherited =
      process.platform === "win32"
        ? explicitlyInheritedNormalized.has(normalizedName)
        : explicitlyInherited.has(name);
    if (!isRuntime && !isProviderAuth && !isExplicitlyInherited) continue;
    if (explicitNames.has(normalizedName)) continue;
    const valueBytes = utf8Bytes(value);
    if (!ENV_NAME.test(name) || valueBytes > MAX_ENV_VALUE_LENGTH || value.includes("\0")) {
      if (isExplicitlyInherited) {
        throw new Error("OMP inherited environment contains an invalid value");
      }
      continue;
    }
    if (isExplicitlyInherited && valueBytes > 0 && valueBytes < 4) {
      throw new OmpPublicError("OMP inherited environment value is too short for safe redaction");
    }
    totalBytes += utf8Bytes(name) + valueBytes;
    if (totalBytes > MAX_ENV_TOTAL_LENGTH) {
      throw new Error("OMP inherited environment is too large");
    }
    env[name] = value;
    if (isExplicitlyInherited && valueBytes > 0) inheritedRedactionValues.push(value);
  }
  let entryCount = 0;
  for (const name in sessionEnv ?? {}) {
    if (!Object.hasOwn(sessionEnv ?? {}, name)) continue;
    entryCount += 1;
    if (entryCount > MAX_ENV_ENTRIES)
      throw new Error("OMP session environment has too many entries");
    const value = (sessionEnv as Readonly<Record<string, string>>)[name];
    const normalizedName = name.toUpperCase();
    if (!ENV_NAME.test(name) || BLOCKED_SESSION_ENV.test(normalizedName)) {
      throw new Error("OMP session environment contains a forbidden variable");
    }
    if (
      typeof value !== "string" ||
      utf8Bytes(value) > MAX_ENV_VALUE_LENGTH ||
      value.includes("\0")
    ) {
      throw new Error("OMP session environment contains an invalid value");
    }
    const valueBytes = utf8Bytes(value);
    totalBytes += utf8Bytes(name) + valueBytes;
    if (totalBytes > MAX_ENV_TOTAL_LENGTH) throw new Error("OMP session environment is too large");
    for (const inheritedName of Object.keys(env)) {
      if (inheritedName !== name && inheritedName.toUpperCase() === normalizedName) {
        delete env[inheritedName];
      }
    }
    env[name] = value;
  }
  return { env, inheritedRedactionValues };
}

export function buildOmpSpawnRequest(
  options: OmpStartOptions,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): OmpSpawnRequest {
  const environmentSource = options.environment ?? sourceEnv;
  const cwd = validateBoundedText(options.cwd, "working directory", MAX_PATH_LENGTH);
  if (!isAbsolute(cwd)) throw new Error("OMP working directory must be absolute");
  const commandPrefix = options.command ?? [environmentSource.OMP_COMMAND ?? "omp"];
  if (commandPrefix.length === 0) throw new Error("Invalid OMP command");
  const [rawCommand, ...rawPrefixArgs] = commandPrefix;
  const command = validateBoundedText(rawCommand, "command", MAX_PATH_LENGTH);
  const args = rawPrefixArgs.map((argument) =>
    validateBoundedText(argument, "command argument", MAX_PATH_LENGTH),
  );
  if (/[\r\n]/u.test(command)) throw new Error("Invalid OMP command");
  const mode = options.mode ?? "full";
  if (mode !== "full" && mode !== "write" && mode !== "ask") throw new Error("Invalid OMP mode");
  const approvalMode = mode === "full" ? "yolo" : mode === "write" ? "write" : "always-ask";
  if (!args.some((argument) => argument === "--mode" || argument.startsWith("--mode="))) {
    args.push("--mode", "rpc-ui");
  }
  args.push("--approval-mode", approvalMode);
  if (options.tools) {
    if (options.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", options.tools.join(","));
  }
  if (options.model !== undefined) {
    args.push("--model", validateBoundedText(options.model, "model", MAX_MODEL_SELECTOR_BYTES));
  }
  if (options.thinkingOption !== undefined) {
    const thinking = OmpThinkingLevelSchema.safeParse(options.thinkingOption);
    if (!thinking.success) throw new Error("Invalid OMP thinking option");
    args.push("--thinking", thinking.data);
  }
  if (options.roleModels?.smol) {
    args.push(
      "--smol",
      validateBoundedText(options.roleModels.smol, "smol model", MAX_MODEL_SELECTOR_BYTES),
    );
  }
  if (options.roleModels?.slow) {
    args.push(
      "--slow",
      validateBoundedText(options.roleModels.slow, "slow model", MAX_MODEL_SELECTOR_BYTES),
    );
  }
  if (options.roleModels?.plan) {
    args.push(
      "--plan",
      validateBoundedText(options.roleModels.plan, "plan model", MAX_MODEL_SELECTOR_BYTES),
    );
  }
  if (options.sessionDir !== undefined) {
    args.push(
      "--session-dir",
      validateBoundedText(options.sessionDir, "session directory", MAX_PATH_LENGTH),
    );
  }
  if (options.resumeSessionId !== undefined) {
    args.push("--resume", validateNativeSessionId(options.resumeSessionId));
  }
  if (options.noSession) args.push("--no-session");
  const systemPrompt = options.systemPrompt?.trim();
  if (systemPrompt) {
    args.push(
      "--append-system-prompt",
      validateBoundedText(systemPrompt, "system prompt", MAX_SYSTEM_PROMPT_LENGTH),
    );
  }
  const { env, inheritedRedactionValues } = buildOmpEnvironment(
    options.env,
    options.inheritEnv,
    environmentSource,
  );
  env.OMP_NO_WEBP = "1";
  return {
    command,
    args,
    cwd,
    env,
    inheritedRedactionValues,
    detached: process.platform !== "win32",
  };
}
