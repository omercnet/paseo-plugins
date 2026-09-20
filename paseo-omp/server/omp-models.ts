import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { listOmpModels, OmpModelCandidate, OmpModelListResult } from "../shared/omp-models";
import { currentOmpEnvironment } from "./paths";
import { OmpRpcRuntime, type OmpRuntime, type OmpRuntimeSession } from "./provider/omp-rpc";
import type { OmpModel } from "./provider/omp-rpc-protocol";
import { OmpCleanupFailure, OmpPublicDataSerializer, OmpPublicError } from "./provider/security";

function mapOmpModel(model: OmpModel, serializer: OmpPublicDataSerializer): OmpModelCandidate {
  const provider = serializer.text(model.provider, 256);
  const id = serializer.text(model.id, 256);
  return {
    selector: `${provider}/${id}`,
    provider,
    id,
    ...(model.name !== undefined ? { name: serializer.text(model.name, 256) } : {}),
    reasoning: model.reasoning === true,
    input: (model.input ?? []).map((value) => serializer.text(value, 256)),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    thinkingLevels: (model.thinking?.efforts ?? []).map((value) => serializer.text(value, 32)),
  };
}

async function closeModelCatalogSession(session: OmpRuntimeSession): Promise<void> {
  const cleanup = session.close();
  try {
    await cleanup;
  } catch {
    throw new OmpCleanupFailure("OMP model catalog cleanup failed", cleanup);
  }
}

export async function resolveListOmpModels(
  input: RpcInput<typeof listOmpModels>,
  runtime: OmpRuntime = new OmpRpcRuntime({ environment: currentOmpEnvironment() }),
): Promise<OmpModelListResult> {
  const cwd = input.cwd ?? homedir();
  if (!isAbsolute(cwd) || cwd.includes("\0")) {
    throw new OmpPublicError("The workspace path is invalid.");
  }
  const session = await runtime.startSession({
    cwd,
    environment: currentOmpEnvironment(),
    noSession: true,
  });
  try {
    const serializer = new OmpPublicDataSerializer();
    return {
      models: (await session.getAvailableModels()).map((model) => mapOmpModel(model, serializer)),
    };
  } finally {
    await closeModelCatalogSession(session);
  }
}
