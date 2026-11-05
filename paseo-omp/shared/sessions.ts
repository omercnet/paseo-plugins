import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

const CwdSchema = z.string().min(1).max(4_096);

export const OmpSessionEntrySchema = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  prompt: z.string(),
  updatedAt: z.string().nullable(),
});
export type OmpSessionEntry = z.infer<typeof OmpSessionEntrySchema>;

export const listOmpSessions = defineRpc({
  name: "paseo-omp.list-sessions",
  input: z.object({ store: OmpStoreSchema.optional(), cwd: CwdSchema }),
  output: z.object({ sessions: z.array(OmpSessionEntrySchema) }),
});
