import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

const OMP_MODEL_TEXT_LIMIT = 256;
const OMP_MODEL_SELECTOR_LIMIT = OMP_MODEL_TEXT_LIMIT * 2 + 1;
const OMP_MODEL_LIST_LIMIT = 4_096;
const OMP_MODEL_INPUT_LIMIT = 16;
const OMP_THINKING_LEVEL_LIMIT = 16;
const OMP_THINKING_LEVEL_TEXT_LIMIT = 32;
const OMP_CONTEXT_WINDOW_LIMIT = 100_000_000;

const OmpModelTextSchema = z.string().min(1).max(OMP_MODEL_TEXT_LIMIT);

export const OmpModelCandidateSchema = z
  .object({
    selector: z.string().min(3).max(OMP_MODEL_SELECTOR_LIMIT),
    provider: OmpModelTextSchema,
    id: OmpModelTextSchema,
    name: z.string().max(OMP_MODEL_TEXT_LIMIT).optional(),
    reasoning: z.boolean(),
    input: z.array(OmpModelTextSchema).max(OMP_MODEL_INPUT_LIMIT),
    contextWindow: z
      .number()
      .int()
      .nonnegative()
      .max(OMP_CONTEXT_WINDOW_LIMIT)
      .nullable()
      .optional(),
    thinkingLevels: z
      .array(z.string().max(OMP_THINKING_LEVEL_TEXT_LIMIT))
      .max(OMP_THINKING_LEVEL_LIMIT),
  })
  .strict();
export type OmpModelCandidate = z.infer<typeof OmpModelCandidateSchema>;

export const OmpModelListResultSchema = z
  .object({ models: z.array(OmpModelCandidateSchema).max(OMP_MODEL_LIST_LIMIT) })
  .strict();
export type OmpModelListResult = z.infer<typeof OmpModelListResultSchema>;

export const listOmpModels = defineRpc({
  name: "paseo-omp.list-models",
  input: z
    .object({ store: OmpStoreSchema.optional(), cwd: OmpWorkspaceCwdSchema.optional() })
    .strict(),
  output: OmpModelListResultSchema,
});
