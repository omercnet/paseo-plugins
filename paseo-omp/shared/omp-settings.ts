import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

export const OMP_SETTINGS_CATALOG_VERSION = 1;

export const OmpSettingTypeSchema = z.enum([
  "boolean",
  "string",
  "number",
  "enum",
  "array",
  "record",
]);
export type OmpSettingType = z.infer<typeof OmpSettingTypeSchema>;
export const OmpScalarValueSchema = z.union([z.boolean(), z.number(), z.string()]);
export type OmpScalarValue = z.infer<typeof OmpScalarValueSchema>;

const MAX_ROUTING_ENTRIES = 64;
const MAX_FALLBACK_CHAIN_LENGTH = 16;
const MAX_AGENT_MODEL_CHOICES = 8;
const MAX_MODEL_SELECTOR_LENGTH = 513;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const OmpRoleNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]*$/,
    "Role names must start with a letter and use only letters, digits, _ or -.",
  );

export const OmpModelSelectorSchema = z
  .string()
  .min(1)
  .max(MAX_MODEL_SELECTOR_LENGTH)
  .refine(
    (value) => utf8ByteLength(value) <= MAX_MODEL_SELECTOR_LENGTH,
    `Model selectors must not exceed ${MAX_MODEL_SELECTOR_LENGTH} UTF-8 bytes.`,
  )
  .refine(
    (value) => value === value.trim() && !/\s/u.test(value) && !containsControlCharacter(value),
    {
      message: "Model selectors must be a single printable token.",
    },
  );

export function isValidOmpModelSelector(value: string): boolean {
  return OmpModelSelectorSchema.safeParse(value).success;
}

const OmpAgentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim() && !containsControlCharacter(value), {
    message: "Agent names cannot have surrounding whitespace or control characters.",
  });

export const OmpModelRolesSchema = z
  .record(OmpRoleNameSchema, OmpModelSelectorSchema)
  .refine((value) => Object.keys(value).length <= MAX_ROUTING_ENTRIES, "Too many model roles.");

const OmpFallbackKeySchema = z.string().superRefine((value, context) => {
  const schema = value.includes("/") ? OmpModelSelectorSchema : OmpRoleNameSchema;
  const result = schema.safeParse(value);
  if (!result.success) {
    context.addIssue({
      code: "custom",
      message: result.error.issues[0]?.message ?? "Invalid fallback chain key.",
    });
  }
});

export const OmpFallbackChainsSchema = z
  .record(OmpFallbackKeySchema, z.array(OmpModelSelectorSchema).max(MAX_FALLBACK_CHAIN_LENGTH))
  .refine((value) => Object.keys(value).length <= MAX_ROUTING_ENTRIES, "Too many fallback chains.");

export const OmpCycleOrderSchema = z
  .array(OmpRoleNameSchema)
  .max(MAX_ROUTING_ENTRIES)
  .refine((value) => new Set(value).size === value.length, "Cycle roles must be unique.");

export const OmpAgentModelOverridesSchema = z
  .record(
    OmpAgentNameSchema,
    z.union([
      OmpModelSelectorSchema,
      z.array(OmpModelSelectorSchema).min(1).max(MAX_AGENT_MODEL_CHOICES),
    ]),
  )
  .refine(
    (value) => Object.keys(value).length <= MAX_ROUTING_ENTRIES,
    "Too many agent model overrides.",
  );

export const OmpAgentServiceTierOverridesSchema = z
  .record(
    OmpAgentNameSchema,
    z.enum(["inherit", "none", "auto", "default", "flex", "scale", "priority"]),
  )
  .refine(
    (value) => Object.keys(value).length <= MAX_ROUTING_ENTRIES,
    "Too many agent service tier overrides.",
  );

const OmpAgentToggleOrSelectorSchema = z.union([z.enum(["on", "off"]), OmpModelSelectorSchema]);

export const OmpAgentPrewalkSchema = z
  .record(OmpAgentNameSchema, OmpAgentToggleOrSelectorSchema)
  .refine(
    (value) => Object.keys(value).length <= MAX_ROUTING_ENTRIES,
    "Too many agent prewalk overrides.",
  );

export const OmpAgentAdvisorSchema = z
  .record(OmpAgentNameSchema, OmpAgentToggleOrSelectorSchema)
  .refine(
    (value) => Object.keys(value).length <= MAX_ROUTING_ENTRIES,
    "Too many agent advisor overrides.",
  );

export const OMP_STRUCTURED_SETTING_PATHS = [
  "modelRoles",
  "retry.fallbackChains",
  "cycleOrder",
  "task.agentModelOverrides",
  "task.agentServiceTierOverrides",
  "task.agentPrewalk",
  "task.agentAdvisor",
] as const;
export type OmpStructuredSettingPath = (typeof OMP_STRUCTURED_SETTING_PATHS)[number];

export function parseOmpStructuredSettingValue(path: string, value: unknown): unknown | undefined {
  switch (path) {
    case "modelRoles":
      return OmpModelRolesSchema.safeParse(value).data;
    case "retry.fallbackChains":
      return OmpFallbackChainsSchema.safeParse(value).data;
    case "cycleOrder":
      return OmpCycleOrderSchema.safeParse(value).data;
    case "task.agentModelOverrides":
      return OmpAgentModelOverridesSchema.safeParse(value).data;
    case "task.agentServiceTierOverrides":
      return OmpAgentServiceTierOverridesSchema.safeParse(value).data;
    case "task.agentPrewalk":
      return OmpAgentPrewalkSchema.safeParse(value).data;
    case "task.agentAdvisor":
      return OmpAgentAdvisorSchema.safeParse(value).data;
    default:
      return undefined;
  }
}

export function isOmpStructuredSettingPath(path: string): path is OmpStructuredSettingPath {
  return (OMP_STRUCTURED_SETTING_PATHS as readonly string[]).includes(path);
}

export const OmpSettingSchema = z
  .object({
    path: z.string(),
    type: OmpSettingTypeSchema,
    description: z.string(),
    value: z.unknown().optional(),
    redacted: z.boolean().optional(),
    configured: z.boolean().optional(),
    workspaceOverride: z.boolean().optional(),
  })
  .strict();
export type OmpSetting = z.infer<typeof OmpSettingSchema>;

export const OMP_SETTING_CATEGORIES = [
  "appearance",
  "model",
  "budget",
  "interaction",
  "context",
  "memory",
  "files",
  "shell",
  "tools",
  "tasks",
  "providers",
  "general",
] as const;
export type OmpSettingCategory = (typeof OMP_SETTING_CATEGORIES)[number];

const CATEGORY_PREFIXES: Readonly<Record<OmpSettingCategory, readonly string[]>> = {
  appearance: [
    "theme.",
    "symbolPreset",
    "colorBlindMode",
    "composer.",
    "statusLine.",
    "terminal.",
    "tui.",
    "display.",
    "showHardwareCursor",
    "images.",
  ],
  model: [
    "modelRoles",
    "modelTags",
    "modelRoleStorage",
    "cycleOrder",
    "enabledModels",
    "defaultThinkingLevel",
    "thinkingBudgets.",
    "hideThinkingBlock",
    "proseOnlyThinking",
    "omitThinking",
    "externalThinking",
    "model.",
    "inlineToolDescriptors",
    "includeModelInPrompt",
    "includeWorkspaceTree",
    "personality",
    "temperature",
    "topP",
    "topK",
    "minP",
    "presencePenalty",
    "repetitionPenalty",
    "textVerbosity",
    "retry.",
    "advisor.",
    "prewalk.",
    "tier.",
  ],
  budget: ["session.warnCost", "session.maxCost"],
  interaction: [
    "autoResume",
    "power.",
    "steeringMode",
    "ask.",
    "stt.",
    "speech.",
    "live.",
    "collab.",
    "magicKeywords",
    "git.",
  ],
  context: ["compaction.", "context.", "contextPromotion.", "ttsr.", "recap.", "branchSummary."],
  memory: ["memory.", "memories.", "mnemopi.", "hindsight.", "sharpshooter."],
  files: ["edit.", "read.", "files.", "file.", "lsp.", "tree"],
  shell: ["bash.", "eval.", "shell", "shellMinimizer."],
  tools: [
    "tools.",
    "todo.",
    "glob.",
    "grep.",
    "astGrep.",
    "astEdit.",
    "debug.",
    "launch.",
    "fetch.",
    "vault.",
    "github.",
    "web_search.",
    "browser.",
    "computer.",
    "checkpoint.",
    "async.",
    "irc.",
    "mcp.",
    "secrets.",
    "extensionHandlers.",
    "dev.",
  ],
  tasks: [
    "plan.",
    "goal.",
    "task.",
    "tasks.",
    "worktree.",
    "skills.",
    "commands.",
    "extensions",
    "disabledExtensions",
  ],
  providers: [
    "providers.",
    "provider.",
    "enabledProviders",
    "disabledProviders",
    "modelProviderOrder",
    "exa.",
    "searxng.",
    "codexResets.",
  ],
  general: [],
};

export function categorizeOmpSetting(path: string): OmpSettingCategory {
  for (const category of OMP_SETTING_CATEGORIES) {
    if (CATEGORY_PREFIXES[category].some((prefix) => path === prefix || path.startsWith(prefix))) {
      return category;
    }
  }
  return "general";
}

export function formatOmpSettingLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : path;
}

/** OMP ships these without a description; unset means no cap. */
export const OMP_SETTING_FALLBACK_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "session.warnCost":
    "Warn once when a session's spend reaches this many US dollars. Leave unset for no warning. Applies to every session, including subagents, and takes effect on the next request.",
  "session.maxCost":
    "Stop a session from sending new model requests once its spend reaches this many US dollars. Leave unset for no limit. Requests already in flight can finish past the limit; raise or reset the value to continue.",
};

export const listOmpSettings = defineRpc({
  name: "paseo-omp.list-settings",
  input: z
    .object({ store: OmpStoreSchema.optional(), cwd: OmpWorkspaceCwdSchema.optional() })
    .strict(),
  output: z.object({
    catalogVersion: z.literal(OMP_SETTINGS_CATALOG_VERSION),
    revision: z.string().optional(),
    path: z.string().optional(),
    available: z.boolean(),
    droppedCount: z.number().int().nonnegative(),
    settings: z.array(OmpSettingSchema),
    error: z.string().optional(),
  }),
});

const OmpScalarSettingPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !isOmpStructuredSettingPath(path),
    "Structured routing settings require typed values.",
  );

const OmpStructuredSettingChangeSchema = z.discriminatedUnion("path", [
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("modelRoles"),
      value: OmpModelRolesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("retry.fallbackChains"),
      value: OmpFallbackChainsSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("cycleOrder"),
      value: OmpCycleOrderSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("task.agentModelOverrides"),
      value: OmpAgentModelOverridesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("task.agentServiceTierOverrides"),
      value: OmpAgentServiceTierOverridesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("task.agentPrewalk"),
      value: OmpAgentPrewalkSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("task.agentAdvisor"),
      value: OmpAgentAdvisorSchema,
    })
    .strict(),
]);

const OmpSettingChangeSchema = z.union([
  z
    .object({
      operation: z.literal("set"),
      path: OmpScalarSettingPathSchema,
      value: OmpScalarValueSchema,
    })
    .strict(),
  OmpStructuredSettingChangeSchema,
  z.object({ operation: z.literal("reset"), path: z.string().min(1) }).strict(),
]);

export const updateOmpSettings = defineRpc({
  name: "paseo-omp.update-settings",
  input: z.object({
    store: OmpStoreSchema.optional(),
    cwd: OmpWorkspaceCwdSchema.optional(),
    revision: z.string(),
    changes: z.array(OmpSettingChangeSchema).min(1).max(100),
  }),
  output: z.object({
    conflict: z.boolean(),
    appliedPaths: z.array(z.string()),
    failed: z.object({ path: z.string(), message: z.string() }).optional(),
    catalog: z.object({
      catalogVersion: z.literal(OMP_SETTINGS_CATALOG_VERSION),
      available: z.boolean(),
      revision: z.string().optional(),
      path: z.string().optional(),
      droppedCount: z.number().int().nonnegative(),
      settings: z.array(OmpSettingSchema),
      error: z.string().optional(),
    }),
  }),
});
