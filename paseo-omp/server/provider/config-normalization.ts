import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { OmpStartOptions } from "./omp-rpc";
import { parseOmpProviderOptions } from "./provider-options";
import { OmpPublicError } from "./security";
import { OmpAdvertisedModeSchema } from "./settings";

export type NormalizedOmpStartOptions = Omit<OmpStartOptions, "environment" | "signal">;
export type OmpRecoveryOptions = Omit<OmpStartOptions, "resumeSessionId" | "signal">;

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
): NormalizedOmpStartOptions {
  if (Object.keys(config.settings).length > 0) {
    throw new OmpPublicError("OMP Plugin Preview does not expose live provider settings");
  }
  const parsedMode = OmpAdvertisedModeSchema.safeParse(config.mode ?? "full");
  if (!parsedMode.success) {
    throw new OmpPublicError(
      `OMP mode '${String(config.mode)}' requires interactive permission support, which this provider does not advertise`,
    );
  }
  const options = parseOmpProviderOptions(config.providerOptions);
  const params = options.params ?? {};
  const env = { ...options.env, ...config.env };
  return {
    cwd: config.cwd,
    ...(options.command ? { command: options.command } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
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
  };
}
