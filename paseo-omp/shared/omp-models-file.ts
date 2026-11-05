import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

/**
 * Whether OMP loaded `models.yml`. A typo makes OMP drop every custom provider with only a
 * warning, so the card says so. `unknown` means the check could not run: never a guess.
 */
export const OmpModelsFileStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok") }),
  /**
   * OMP's own validation message, control characters stripped and bounded. Values OMP echoes as
   * "(was ...)" are removed; field paths and the provider and model names from the file remain.
   */
  z.object({ state: z.literal("invalid"), detail: z.string().max(400) }),
  z.object({ state: z.literal("unknown") }),
]);
export type OmpModelsFileStatus = z.infer<typeof OmpModelsFileStatusSchema>;

export const getOmpModelsFileStatus = defineRpc({
  name: "paseo-omp.get-models-file-status",
  input: z.object({ store: OmpStoreSchema.optional() }),
  output: OmpModelsFileStatusSchema,
});

export const refreshOmpModels = defineRpc({
  name: "paseo-omp.refresh-models",
  input: z.object({ store: OmpStoreSchema.optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
