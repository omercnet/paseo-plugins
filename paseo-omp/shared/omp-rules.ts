import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

/** A watch rule fires on what the agent writes; always-apply and rulebook rules sit in the prompt. */
export const OmpRuleKindSchema = z.enum(["watch", "always", "rulebook"]);
export type OmpRuleKind = z.infer<typeof OmpRuleKindSchema>;

/** `imported` is a rule OMP reads from another tool's files (Cursor, Windsurf, Cline, ...). */
export const OmpRuleSourceSchema = z.enum(["project", "user", "builtin", "imported"]);

export const OmpRuleSchema = z.object({
  name: z.string(),
  kind: OmpRuleKindSchema,
  source: OmpRuleSourceSchema,
  /** OMP's provider id, such as `native`, `builtin-defaults`, or `cursor`. */
  provider: z.string(),
  description: z.string().nullable(),
  condition: z.array(z.string()),
  astCondition: z.array(z.string()),
  question: z.string().nullable(),
  scope: z.array(z.string()),
  globs: z.array(z.string()),
  agents: z.array(z.string()),
  path: z.string(),
});
export type OmpRule = z.infer<typeof OmpRuleSchema>;

export const OmpRulesListSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    rules: z.array(OmpRuleSchema),
    /** `ttsr.disabledRules`: OMP hides these, so only their names are known. */
    disabled: z.array(z.string()),
    /** `ttsr.builtinRules`: false hides every built-in rule. */
    builtinRules: z.boolean(),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type OmpRulesList = z.infer<typeof OmpRulesListSchema>;

export const listOmpRules = defineRpc({
  name: "paseo-omp.list-rules",
  input: z
    .object({ store: OmpStoreSchema.optional(), cwd: OmpWorkspaceCwdSchema.optional() })
    .strict(),
  output: OmpRulesListSchema,
});
