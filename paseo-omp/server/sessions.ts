import type { RpcInput } from "@getpaseo/plugin";
import type { listOmpSessions, OmpSessionEntry } from "../shared/sessions";
import { currentOmpEnvironment } from "./paths";
import { listOmpSessionDescriptors } from "./provider/session-descriptors";

const ROW_LIMIT = 100;

// OMP records prompt-history rows only from its interactive editor, never in RPC mode, so
// Paseo-driven sessions are listed from their session files instead.
export async function resolveListOmpSessions({
  cwd,
}: RpcInput<typeof listOmpSessions>): Promise<{ sessions: OmpSessionEntry[] }> {
  const descriptors = await listOmpSessionDescriptors(
    { cwd, limit: ROW_LIMIT },
    currentOmpEnvironment(),
  );
  return {
    sessions: descriptors.map((descriptor) => ({
      sessionId: descriptor.id,
      title: descriptor.title ?? null,
      prompt: descriptor.firstPromptPreview ?? descriptor.lastPromptPreview ?? "",
      updatedAt: descriptor.updatedAt ?? null,
    })),
  };
}
