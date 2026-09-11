import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import type { OmpModel, OmpRuntime, OmpRuntimeSession } from "./omp-rpc";
import { OmpCleanupFailure, OmpPublicDataFilter, OmpPublicError } from "./security";

export const OMP_MODES: readonly ProviderMode[] = [
  {
    id: "full",
    label: "Full Access",
    description: "Launches OMP with yolo approval mode so tools run without prompts.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
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

export function mapOmpModels(
  models: readonly OmpModel[],
  filter = new OmpPublicDataFilter(),
): ProviderModel[] {
  const seenIds = new Map<string, string>();
  return models.map((model) => {
    const thinkingOptions = thinkingForModel(model);
    const id = ompModelId(model);
    const nativeIdentity = nativeOmpModelId(model);
    const existing = seenIds.get(id);
    if (existing !== undefined && existing !== nativeIdentity) {
      throw new Error("OMP model identity collision");
    }
    if (existing !== undefined) throw new Error("OMP reported a duplicate model identity");
    seenIds.set(id, nativeIdentity);
    const provider = filter.text(model.provider, 256);
    const modelId = filter.text(model.id, 256);
    const name = model.name ? filter.text(model.name, 256) : modelId;
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
    throw new OmpCleanupFailure(
      "OMP catalog cleanup failed",
      cleanup.catch(() => undefined),
    );
  }
}

export async function discoverOmpCatalog(
  runtime: OmpRuntime,
  cwd?: string,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<ProviderCatalog> {
  const session = await runtime.startSession({
    cwd: cwd ?? homedir(),
    mode: "full",
    noSession: true,
    signal,
    environment,
  });
  try {
    const [nativeModels, state] = await Promise.all([
      session.getAvailableModels(),
      session.getState(),
    ]);
    const filter = new OmpPublicDataFilter(session.redactionValues ?? []);
    const models = mapOmpModels(nativeModels, filter);
    if (models.length === 0) throw new Error("OMP reported no available models");
    const defaultModel = state.model ? ompModelId(state.model) : models[0]?.id;
    const currentModel = state.model
      ? nativeModels.find(
          (model) => model.provider === state.model?.provider && model.id === state.model.id,
        )
      : nativeModels[0];
    if (state.model && !currentModel) throw new Error("OMP reported an unadvertised active model");
    const thinkingOptions = thinkingForModel(currentModel);
    return {
      models,
      modes: OMP_MODES,
      thinkingOptions,
      defaultModel,
      defaultMode: "full",
      ...(state.thinkingLevel ? { defaultThinkingOption: state.thinkingLevel } : {}),
    };
  } finally {
    await closeCatalogSession(session);
  }
}
