import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

/** Model keys come from `omp tiny-models list`, for example `lfm2.5-230m` or `llama3.2:3b`. */
export const OmpLocalModelKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u);

export const OmpLocalModelSchema = z.object({
  key: OmpLocalModelKeySchema,
  label: z.string(),
  description: z.string(),
  /** Approximate download size parsed from OMP's description, when it names one. */
  sizeMb: z.number().nullable(),
  /** Found in OMP's cache folder. OMP's list does not report this itself. */
  downloaded: z.boolean(),
  download: z.enum(["idle", "running", "failed"]),
  error: z.string().nullable(),
});
export type OmpLocalModel = z.infer<typeof OmpLocalModelSchema>;

export const listOmpLocalModels = defineRpc({
  name: "paseo-omp.list-local-models",
  input: z.object({ store: OmpStoreSchema.optional() }).strict(),
  output: z.object({
    available: z.boolean(),
    models: z.array(OmpLocalModelSchema),
  }),
});

export const downloadOmpLocalModel = defineRpc({
  name: "paseo-omp.download-local-model",
  input: z.object({ store: OmpStoreSchema.optional(), key: OmpLocalModelKeySchema }).strict(),
  output: z.object({ outcome: z.enum(["started", "busy", "unknown-model", "unavailable"]) }),
});

/** The roles record with `role` pointed at `selector`, or removed when `selector` is null. */
export function withLocalModelRole(
  roles: Readonly<Record<string, unknown>>,
  role: string,
  selector: string | null,
): Record<string, unknown> {
  const { [role]: _replaced, ...rest } = roles;
  return selector === null ? rest : { ...rest, [role]: selector };
}

/**
 * What pressing a model's role button may do. OMP merges a project `modelRoles` override with the
 * global record key by key and has no value that clears a role, so a workspace write can set a role
 * but never stop an inherited one: there the "Stop using" press is unavailable.
 */
export function localModelRoleAction(
  assigned: boolean,
  workspaceScoped: boolean,
): "use" | "stop" | "unavailable" {
  if (!assigned) return "use";
  return workspaceScoped ? "unavailable" : "stop";
}
