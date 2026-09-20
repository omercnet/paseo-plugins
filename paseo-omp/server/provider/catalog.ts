import { createHash } from "node:crypto";
import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import type { NormalizedOmpStartOptions } from "./config-normalization";
import type { OmpRuntime, OmpRuntimeSession } from "./omp-rpc";
import type { OmpModel } from "./omp-rpc-protocol";
import {
  configuredOutputRedactionValues,
  OmpCleanupFailure,
  OmpPublicDataSerializer,
  OmpPublicError,
} from "./security";

export const OMP_MODES: readonly ProviderMode[] = [
  {
    id: "full",
    label: "Full Access",
    description: "Runs all tools without approval prompts.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
  {
    id: "write",
    label: "Write Approval",
    description: "Runs reads without approval; writes require approval.",
    icon: "ShieldAlert",
    colorTier: "moderate",
  },
  {
    id: "ask",
    label: "Always Ask",
    description: "Requires approval for write and execution tools.",
    icon: "ShieldCheck",
    colorTier: "safe",
  },
];

const THINKING_OPTIONS: readonly ProviderThinkingOption[] = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Extra-high reasoning" },
  { id: "max", label: "Max", description: "Maximum reasoning" },
];
export const OMP_MAX_CATALOG_MODELS = 256;

export function selectOmpModels(
  models: readonly OmpModel[],
  activeModel: OmpModel | null | undefined,
): OmpModel[] {
  if (models.length <= OMP_MAX_CATALOG_MODELS) return [...models];
  const selected = models.slice(0, OMP_MAX_CATALOG_MODELS);
  if (!activeModel) return selected;
  const active = models.find(
    (model) => model.provider === activeModel.provider && model.id === activeModel.id,
  );
  if (
    !active ||
    selected.some((model) => model.provider === active.provider && model.id === active.id)
  ) {
    return selected;
  }
  selected[OMP_MAX_CATALOG_MODELS - 1] = active;
  return selected;
}

export function nativeOmpModelId(model: OmpModel): string {
  if (model.provider.includes("/")) {
    throw new OmpPublicError("OMP reported an invalid model provider");
  }
  return `${model.provider}/${model.id}`;
}

export function ompModelId(model: OmpModel): string {
  const nativeIdentity = `${Buffer.byteLength(model.provider, "utf8")}:${model.provider}${Buffer.byteLength(model.id, "utf8")}:${model.id}`;
  return `omp:model:${createHash("sha256").update(nativeIdentity).digest("hex")}`;
}
export function validateOmpModelIdentities(models: readonly OmpModel[]): void {
  const seenIds = new Map<string, string>();
  for (const model of models) {
    const id = ompModelId(model);
    const nativeIdentity = nativeOmpModelId(model);
    const existing = seenIds.get(id);
    if (existing !== undefined && existing !== nativeIdentity) {
      throw new Error("OMP model identity collision");
    }
    if (existing !== undefined) throw new Error("OMP reported a duplicate model identity");
    seenIds.set(id, nativeIdentity);
  }
}

export function mapOmpModels(
  models: readonly OmpModel[],
  serializer = new OmpPublicDataSerializer(),
): ProviderModel[] {
  validateOmpModelIdentities(models);
  return models.map((model) => {
    const thinkingOptions = thinkingForModel(model);
    const id = ompModelId(model);
    const provider = serializer.text(model.provider, 256);
    const modelId = serializer.text(model.id, 256);
    const name = model.name ? serializer.text(model.name, 256) : modelId;
    return {
      id,
      label: `${provider}/${name}`,
      description: `${provider}/${modelId}`,
      ...(typeof model.contextWindow === "number"
        ? { contextWindowMaxTokens: model.contextWindow }
        : {}),
      ...(thinkingOptions.length > 0
        ? {
            thinkingOptions,
            defaultThinkingOptionId:
              thinkingOptions.find((option) => option.isDefault)?.id ?? thinkingOptions[0]?.id,
          }
        : {}),
      metadata: { provider, modelId },
    };
  });
}

export function thinkingForModel(model: OmpModel | null | undefined): ProviderThinkingOption[] {
  if (!model?.reasoning) return [];
  const efforts = model.thinking?.efforts ?? [];
  const supported = THINKING_OPTIONS.filter((option) => efforts.includes(option.id));
  const defaultLevel = model.thinking?.defaultLevel;
  const selectedDefault = supported.some((option) => option.id === defaultLevel)
    ? defaultLevel
    : supported[0]?.id;
  return supported.map((option) => ({ ...option, isDefault: option.id === selectedDefault }));
}

async function closeCatalogSession(session: OmpRuntimeSession): Promise<void> {
  const cleanup = session.close();
  try {
    await cleanup;
  } catch {
    throw new OmpCleanupFailure("OMP catalog cleanup failed", cleanup);
  }
}

export async function discoverOmpCatalog(
  runtime: OmpRuntime,
  options: NormalizedOmpStartOptions,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<ProviderCatalog> {
  const session = await runtime.startSession({
    ...options,
    signal,
    environment,
  });
  try {
    const [nativeModels, state] = await Promise.all([
      session.getAvailableModels(),
      session.getState(),
    ]);
    const configuredValues = configuredOutputRedactionValues(
      options.outputRedaction ?? "none",
      options.env,
    );
    const serializer = new OmpPublicDataSerializer(
      options.outputRedaction === "configured-values"
        ? [...configuredValues, ...(session.inheritedRedactionValues ?? [])]
        : configuredValues,
    );
    validateOmpModelIdentities(nativeModels);
    const selectedNativeModels = selectOmpModels(nativeModels, state.model);
    const models = mapOmpModels(selectedNativeModels, serializer);
    if (models.length === 0) throw new Error("OMP reported no available models");
    const defaultModel = state.model ? ompModelId(state.model) : models[0]?.id;
    const currentModel = state.model
      ? selectedNativeModels.find(
          (model) => model.provider === state.model?.provider && model.id === state.model.id,
        )
      : selectedNativeModels[0];
    if (state.model && !currentModel) throw new Error("OMP reported an unadvertised active model");
    const thinkingOptions = thinkingForModel(currentModel);
    const defaultThinkingOption = thinkingOptions.some(
      (option) => option.id === state.thinkingLevel,
    )
      ? state.thinkingLevel
      : undefined;
    return {
      models,
      modes: OMP_MODES,
      thinkingOptions,
      defaultModel,
      defaultMode: "full",
      ...(defaultThinkingOption ? { defaultThinkingOption } : {}),
    };
  } finally {
    await closeCatalogSession(session);
  }
}
