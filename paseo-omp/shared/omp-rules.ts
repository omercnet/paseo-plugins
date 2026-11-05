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

/** Off adds `name` to `ttsr.disabledRules`; on removes it. A workspace writes its own `.omp/config.yml`. */
export const setOmpRuleEnabled = defineRpc({
  name: "paseo-omp.set-rule-enabled",
  input: z
    .object({
      store: OmpStoreSchema.optional(),
      cwd: OmpWorkspaceCwdSchema.optional(),
      name: z.string().trim().min(1).max(256),
      enabled: z.boolean(),
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok") }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});

export const MAX_RULE_TEST_CHARS = 20_000;

export const OmpRuleTestSourceSchema = z.enum(["text", "thinking", "tool"]);
export type OmpRuleTestSource = z.infer<typeof OmpRuleTestSourceSchema>;

export const OmpRuleTestHitSchema = z.object({
  name: z.string(),
  provider: z.string(),
  path: z.string(),
  /** The rule's own patterns that matched the snippet. */
  regex: z.array(z.string()),
  ast: z.array(z.string()),
});
export type OmpRuleTestHit = z.infer<typeof OmpRuleTestHitSchema>;

/** Runs `omp ttsr test`: which rules would fire on a snippet, in this workspace or the user scope. */
export const testOmpRules = defineRpc({
  name: "paseo-omp.test-rules",
  input: z
    .object({
      store: OmpStoreSchema.optional(),
      cwd: OmpWorkspaceCwdSchema.optional(),
      snippet: z.string().min(1).max(MAX_RULE_TEST_CHARS),
      /** The file the snippet pretends to come from, for scope and glob matching. */
      path: z
        .string()
        .trim()
        .min(1)
        .max(1_024)
        .refine((path) => !path.includes("\0"), "The path cannot hold a null character")
        .optional(),
      source: OmpRuleTestSourceSchema.optional(),
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ready"),
      /** How many rules OMP checked. */
      evaluated: z.number().int().nonnegative(),
      triggered: z.array(OmpRuleTestHitSchema),
    }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});
