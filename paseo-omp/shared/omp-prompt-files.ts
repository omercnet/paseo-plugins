import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

/** Facts only: never the text of a prompt file or of Paseo's Append system prompt. */
export const OmpPromptFilesSchema = z.object({
  /** An APPEND_SYSTEM.md exists in the agent directory (or the workspace's `.omp/`). */
  appendSystemFile: z.boolean(),
  /** A SYSTEM.md exists there: it replaces OMP's default instruction template. */
  systemFile: z.boolean(),
  /** Whether Paseo has an Append system prompt set. */
  hostAppendPrompt: z.boolean(),
});
export type OmpPromptFiles = z.infer<typeof OmpPromptFilesSchema>;

export const getOmpPromptFiles = defineRpc({
  name: "paseo-omp.get-prompt-files",
  input: z.object({
    store: OmpStoreSchema.optional(),
    cwd: OmpWorkspaceCwdSchema.optional(),
  }),
  output: OmpPromptFilesSchema,
});
