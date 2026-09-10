import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const workspaceFreshness = defineRpc({
  name: "fresh-worktrees.workspace-freshness",
  input: z.object({
    projectRootPath: z.string().min(1),
    workspaceDirectory: z.string().min(1),
  }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("behind"), remoteRef: z.string(), behindBy: z.number().int().positive() }),
    z.object({ kind: z.literal("current"), remoteRef: z.string() }),
    z.object({ kind: z.literal("unavailable") }),
  ]),
});
