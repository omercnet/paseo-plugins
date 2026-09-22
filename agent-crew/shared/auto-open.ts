import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_AUTO_OPEN_CLAIM_BATCH = 1000;

export const claimOpenedWorkspaces = defineRpc({
  name: "agent-crew.auto-open.claim",
  input: z.object({
    workspaceIds: z.array(z.string().min(1)).min(1).max(MAX_AUTO_OPEN_CLAIM_BATCH),
  }),
  output: z.object({ claimed: z.array(z.string()) }),
});

export function claimUnclaimedWorkspaces(
  opened: ReadonlySet<string>,
  candidates: readonly string[],
): string[] {
  const claimed: string[] = [];
  for (const workspaceId of candidates) {
    if (opened.has(workspaceId) || claimed.includes(workspaceId)) continue;
    claimed.push(workspaceId);
  }
  return claimed;
}
