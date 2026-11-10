import { isDeepStrictEqual } from "node:util";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { OmpStartOptions } from "./omp-rpc-environment";

type ProviderCatalogOptionsCompat = {
  scope: "global" | "workspace";
  cwd?: string;
  force?: boolean;
  providerOptions?: Readonly<Record<string, unknown>>;
  settings?: Readonly<Record<string, unknown>>;
};

import { MAX_INHERITED_ENVIRONMENT_NAMES } from "../../shared/provider-launch-settings";
import { parseOmpProviderOptions } from "./provider-options";
import { OmpPublicError } from "./security";
import { withoutOmpSessionPurpose } from "./session-purpose";
import { OmpModeSchema } from "./settings";

/**
 * Whether a session asks for provider settings OMP does not expose. Paseo 0.14/0.15 fill
 * `settings` from feature values; Paseo 0.16 mirrors `providerOptions` there instead, so a key
 * that only repeats the same `providerOptions` value is not a setting.
 */
export function hasOmpProviderSettings(settings: unknown, providerOptions: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const options =
    providerOptions && typeof providerOptions === "object"
      ? (providerOptions as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(options, key)) return true;
    if (!isDeepStrictEqual(value, options[key])) return true;
  }
  return false;
}

const OMP_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "eval",
  "github",
  "glob",
  "grep",
  "lsp",
  "checkpoint",
  "rewind",
  "security_scan",
  "task",
  "hub",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
] as const;
const OMP_BUILTIN_TOOL_NAME_SET: Readonly<Record<string, true>> = Object.fromEntries(
  OMP_BUILTIN_TOOL_NAMES.map((name) => [name, true]),
);

function allowedOmpTools(deniedTools: readonly string[] | undefined): string[] | undefined {
  if (!deniedTools?.length) return;
  const denied = new Set(deniedTools.map((name) => name.trim().toLowerCase()));
  const unsupported = [...denied].filter((name) => OMP_BUILTIN_TOOL_NAME_SET[name] !== true);
  if (unsupported.length > 0) {
    throw new OmpPublicError(
      `OMP cannot enforce unknown denied tools: ${unsupported.sort().join(", ")}`,
    );
  }
  return OMP_BUILTIN_TOOL_NAMES.filter((name) => !denied.has(name));
}

export type NormalizedOmpStartOptions = Omit<OmpStartOptions, "environment" | "signal">;
export type OmpRecoveryOptions = Omit<OmpStartOptions, "resumeSessionId" | "signal">;
export function mergeOmpInheritedEnvironmentNames(
  hostNames: readonly string[],
  profileNames: readonly string[] | undefined,
): string[] | undefined {
  const names = [...new Set([...hostNames, ...(profileNames ?? [])])];
  if (names.length > MAX_INHERITED_ENVIRONMENT_NAMES) {
    throw new OmpPublicError("OMP inherited environment has too many entries");
  }
  return names.length > 0 ? names : undefined;
}

export function normalizeOmpCatalogOptions(
  options: ProviderCatalogOptionsCompat,
  cwd: string,
  hostInheritEnv: readonly string[] = [],
): Omit<OmpStartOptions, "environment" | "signal"> {
  const providerOptions = parseOmpProviderOptions(options.providerOptions);
  const inheritEnv = mergeOmpInheritedEnvironmentNames(hostInheritEnv, providerOptions.inheritEnv);
  const params = providerOptions.params ?? {};
  return {
    cwd,
    mode: "full",
    noSession: true,
    ...(providerOptions.command ? { command: providerOptions.command } : {}),
    ...(providerOptions.env ? { env: withoutOmpSessionPurpose(providerOptions.env) } : {}),
    ...(inheritEnv ? { inheritEnv } : {}),
    outputRedaction: providerOptions.outputRedaction,
    ...(params.sessionDir ? { sessionDir: params.sessionDir } : {}),
    ...(params.rpcTimeoutMs
      ? { readyTimeoutMs: params.rpcTimeoutMs, requestTimeoutMs: params.rpcTimeoutMs }
      : {}),
    ...((params.smolModel || params.slowModel || params.planModel) && {
      roleModels: {
        ...(params.smolModel ? { smol: params.smolModel } : {}),
        ...(params.slowModel ? { slow: params.slowModel } : {}),
        ...(params.planModel ? { plan: params.planModel } : {}),
      },
    }),
  };
}
/** Replace only runtime-committed selection fields on an immutable recovery template. */
export function withCommittedOmpSelection(
  template: OmpRecoveryOptions,
  selection: Readonly<{ model?: string; thinkingOption?: string }>,
): OmpRecoveryOptions {
  const next = { ...template };
  if (selection.model === undefined) delete next.model;
  else next.model = selection.model;
  if (selection.thinkingOption === undefined) delete next.thinkingOption;
  else next.thinkingOption = selection.thinkingOption;
  return next;
}

/** Convert the public plugin session envelope into the native OMP launch contract. */
export function normalizeOmpSessionConfig(
  config: ProviderSessionConfig,
  permissionSupported = false,
  hostInheritEnv: readonly string[] = [],
): NormalizedOmpStartOptions {
  if (hasOmpProviderSettings(config.settings, config.providerOptions)) {
    throw new OmpPublicError("OMP does not expose live provider settings");
  }
  const parsedMode = OmpModeSchema.safeParse(config.mode ?? "full");
  if (!parsedMode.success) {
    throw new OmpPublicError(`Unsupported OMP mode '${String(config.mode)}'`);
  }
  if (parsedMode.data !== "full" && !permissionSupported) {
    throw new OmpPublicError(
      `OMP mode '${parsedMode.data}' requires negotiated permission support`,
    );
  }
  const options = parseOmpProviderOptions(config.providerOptions);
  const deniedTools = (config as ProviderSessionConfig & { deniedTools?: readonly string[] })
    .deniedTools;
  const tools = allowedOmpTools(deniedTools);
  const params = options.params ?? {};
  const env = withoutOmpSessionPurpose({ ...options.env, ...config.env });
  const inheritEnv = mergeOmpInheritedEnvironmentNames(hostInheritEnv, options.inheritEnv);
  return {
    cwd: config.cwd,
    ...(options.command ? { command: options.command } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(inheritEnv ? { inheritEnv } : {}),
    outputRedaction: options.outputRedaction,
    mode: parsedMode.data,
    thinkingOption: config.thinkingOption,
    systemPrompt: config.systemPrompt,
    noSession: !config.persist,
    ...(params.sessionDir ? { sessionDir: params.sessionDir } : {}),
    ...(params.rpcTimeoutMs
      ? { readyTimeoutMs: params.rpcTimeoutMs, requestTimeoutMs: params.rpcTimeoutMs }
      : {}),
    ...((params.smolModel || params.slowModel || params.planModel) && {
      roleModels: {
        ...(params.smolModel ? { smol: params.smolModel } : {}),
        ...(params.slowModel ? { slow: params.slowModel } : {}),
        ...(params.planModel ? { plan: params.planModel } : {}),
      },
    }),
    ...(tools ? { tools } : {}),
  };
}
