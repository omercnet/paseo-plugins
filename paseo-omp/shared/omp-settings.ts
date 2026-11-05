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
const MAX_BASH_RULES = 128;

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

export const OmpAgentNameSchema = z
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

export const OmpDisabledAgentsSchema = z
  .array(OmpAgentNameSchema)
  .max(MAX_ROUTING_ENTRIES)
  .refine((value) => new Set(value).size === value.length, "Disabled agents must be unique.");

export const OmpToolApprovalSchema = z.enum(["allow", "prompt", "deny"]);
export type OmpToolApproval = z.infer<typeof OmpToolApprovalSchema>;

export const OmpToolPoliciesSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u, "Tool names use letters, digits and _ . : -."),
    OmpToolApprovalSchema,
  )
  .refine((value) => Object.keys(value).length <= MAX_ROUTING_ENTRIES, "Too many tool policies.");

export const OmpBashRuleSchema = z
  .object({
    match: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !containsControlCharacter(value), "Rules cannot hold control characters."),
    approval: OmpToolApprovalSchema,
  })
  .strict();
export type OmpBashRule = z.infer<typeof OmpBashRuleSchema>;

export const OmpBashRulesSchema = z.array(OmpBashRuleSchema).max(MAX_BASH_RULES);

export const OmpRestrictedFoldersSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => !containsControlCharacter(value),
        "Folders cannot hold control characters.",
      ),
  )
  .max(MAX_ROUTING_ENTRIES)
  .refine((value) => new Set(value).size === value.length, "Restricted folders must be unique.");

export const OMP_STRUCTURED_SETTING_PATHS = [
  "modelRoles",
  "retry.fallbackChains",
  "cycleOrder",
  "task.agentModelOverrides",
  "task.agentServiceTierOverrides",
  "task.agentPrewalk",
  "task.agentAdvisor",
  "task.disabledAgents",
  "tools.approval",
  "bash.patterns",
  "tools.restrictedFolders",
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
    case "task.disabledAgents":
      return OmpDisabledAgentsSchema.safeParse(value).data;
    case "tools.approval":
      return OmpToolPoliciesSchema.safeParse(value).data;
    case "bash.patterns":
      return OmpBashRulesSchema.safeParse(value).data;
    case "tools.restrictedFolders":
      return OmpRestrictedFoldersSchema.safeParse(value).data;
    default:
      return undefined;
  }
}

export function isOmpStructuredSettingPath(path: string): path is OmpStructuredSettingPath {
  return (OMP_STRUCTURED_SETTING_PATHS as readonly string[]).includes(path);
}

const ARRAY_STRUCTURED_SETTING_PATHS: readonly string[] = [
  "cycleOrder",
  "task.disabledAgents",
  "bash.patterns",
  "tools.restrictedFolders",
];

/** The OMP value type each structured path must have to be editable. */
export function structuredSettingType(path: OmpStructuredSettingPath): "array" | "record" {
  return ARRAY_STRUCTURED_SETTING_PATHS.includes(path) ? "array" : "record";
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
    /** Workspace scope only: the user-level value of a setting whose project value merges with it. */
    userValue: z.unknown().optional(),
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

/** The optional-tool on/off switches, in the order they list when all are the same state. */
const OMP_TOOL_SWITCHES: readonly { path: string; label: string; description: string }[] = [
  {
    path: "github.enabled",
    label: "GitHub",
    description:
      "Repositories, issues, pull requests and Actions from the agent. Needs the gh command on the PATH.",
  },
  {
    path: "security.enabled",
    label: "Security scan",
    description: "Security scan planning and execution, plus the read-only security:// resources.",
  },
  {
    path: "generate_image.enabled",
    label: "Image generation",
    description: "Text-to-image generation and editing.",
  },
  {
    path: "speechgen.enabled",
    label: "Speech synthesis",
    description: "Turns text into speech files, on-device or with xAI Grok Voice.",
  },
  {
    path: "computer.enabled",
    label: "Desktop control",
    description:
      "Lets the agent script this machine's desktop: screenshots, input and accessibility.",
  },
  {
    path: "lsp.enabled",
    label: "Language servers",
    description: "Code intelligence: definitions, references, diagnostics and rename.",
  },
  {
    path: "debug.enabled",
    label: "Debugger",
    description: "Debugging through DAP adapters.",
  },
  {
    path: "ida.enabled",
    label: "IDA Pro",
    description:
      "Opens executables in IDA Pro and adds the ida tool. Does nothing without an IDA install.",
  },
  {
    path: "checkpoint.enabled",
    label: "Checkpoints",
    description: "Checkpoint and rewind tools for saving and restoring context.",
  },
  {
    path: "task.isolation.enabled",
    label: "Task isolation",
    description: "Lets a task run apart from the shared checkout when it asks to.",
  },
  {
    path: "magicKeywords.enabled",
    label: "Magic keywords",
    description:
      "Hidden notices when a message holds a standalone ultrathink, orchestrate, workflowz or jevify keyword.",
  },
];

const TOOL_SWITCH_LABELS = new Map(OMP_TOOL_SWITCHES.map(({ path, label }) => [path, label]));
const SETTING_LABELS = new Map([
  ...TOOL_SWITCH_LABELS,
  ["tools.approvalMode", "Approval mode (not used by Paseo)"],
]);

const OMP_TOOL_POLICY_PATHS: readonly string[] = [
  "tools.approval",
  "bash.patterns",
  "tools.restrictedFolders",
];

/** Settings the Tool policy card edits in place of the generic list. */
export function isOmpToolPolicyPath(path: string): boolean {
  return OMP_TOOL_POLICY_PATHS.includes(path);
}

export function categorizeOmpSetting(path: string): OmpSettingCategory {
  if (TOOL_SWITCH_LABELS.has(path) || isOmpToolPolicyPath(path)) return "tools";
  for (const category of OMP_SETTING_CATEGORIES) {
    if (CATEGORY_PREFIXES[category].some((prefix) => path === prefix || path.startsWith(prefix))) {
      return category;
    }
  }
  return "general";
}

export function formatOmpSettingLabel(path: string): string {
  const settingLabel = SETTING_LABELS.get(path);
  if (settingLabel) return settingLabel;
  const leaf = path.split(".").at(-1) ?? path;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : path;
}

/** Tools category order: enabled switches, then disabled switches, then every other tool setting. */
export function orderOmpToolSettings(settings: readonly OmpSetting[]): OmpSetting[] {
  const byPath = new Map(settings.map((setting) => [setting.path, setting]));
  const switches = OMP_TOOL_SWITCHES.flatMap(({ path }) => byPath.get(path) ?? []);
  const enabled = switches.filter((setting) => setting.value === true);
  const disabled = switches.filter((setting) => setting.value !== true);
  const rest = settings.filter((setting) => !TOOL_SWITCH_LABELS.has(setting.path));
  return [...enabled, ...disabled, ...rest];
}

/** Plain wording that replaces OMP's own description (or its absence) for these settings. */
export const OMP_SETTING_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(OMP_TOOL_SWITCHES.map(({ path, description }) => [path, description])),
  "tools.approvalMode":
    "Has no effect on Paseo agents: Paseo launches OMP with its own approval mode (Full Access, Write Approval or Always Ask), and that flag overrides this setting. It only applies to OMP run outside Paseo.",
  "session.warnCost":
    "Warn once when a session's spend reaches this many US dollars. Leave unset for no warning. Applies to every session, including subagents, and takes effect on the next request.",
  "session.maxCost":
    "Stop a session from sending new model requests once its spend reaches this many US dollars. Leave unset for no limit. Requests already in flight can finish past the limit; raise or reset the value to continue.",
  "secrets.enabled":
    "Hides keys, tokens and passwords from the model provider. Values are swapped for placeholders before text is sent and restored when the model uses them in a tool call. OMP detects environment variables named like KEY, TOKEN, SECRET or PASSWORD, passwords of 8 or more characters in connection URLs held in environment variables, and common token formats. Custom rules live in secrets.yml in the OMP agent folder or a project's .omp folder; edit that file by hand, Paseo never shows it. Best effort, not a guarantee: system prompts, static tool definitions and images are not covered. Applies to new sessions.",
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
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("task.disabledAgents"),
      value: OmpDisabledAgentsSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("tools.approval"),
      value: OmpToolPoliciesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("bash.patterns"),
      value: OmpBashRulesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      path: z.literal("tools.restrictedFolders"),
      value: OmpRestrictedFoldersSchema,
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
