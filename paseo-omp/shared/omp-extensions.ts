import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

export const OmpExtensionKindSchema = z.enum(["extension", "hook", "tool"]);
export type OmpExtensionKind = z.infer<typeof OmpExtensionKindSchema>;

export const OmpExtensionItemSchema = z.object({
  kind: OmpExtensionKindSchema,
  /** A hook reads `pre/<file>` or `post/<file>`. */
  name: z.string(),
  level: z.enum(["project", "user"]),
  path: z.string(),
  /** The entry OMP matches in `disabledExtensions`. */
  id: z.string(),
  enabled: z.boolean(),
});
export type OmpExtensionItem = z.infer<typeof OmpExtensionItemSchema>;

export const OmpExtensionsListSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), items: z.array(OmpExtensionItemSchema) }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type OmpExtensionsList = z.infer<typeof OmpExtensionsListSchema>;

const ScopeSchema = { store: OmpStoreSchema.optional(), cwd: OmpWorkspaceCwdSchema.optional() };

export const listOmpExtensions = defineRpc({
  name: "paseo-omp.list-extensions",
  input: z.object(ScopeSchema).strict(),
  output: OmpExtensionsListSchema,
});

/** Off adds `id` to `disabledExtensions`; on removes it. A workspace writes its own `.omp/config.yml`. */
export const setOmpExtensionEnabled = defineRpc({
  name: "paseo-omp.set-extension-enabled",
  input: z
    .object({ ...ScopeSchema, id: z.string().trim().min(1).max(512), enabled: z.boolean() })
    .strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok") }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});
