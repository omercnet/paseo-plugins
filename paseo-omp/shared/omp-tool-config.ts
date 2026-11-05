import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

/** OMP reads `lsp.json` for language servers and `dap.json` for debug adapters, from the user and the project. */
export const OmpToolConfigKindSchema = z.enum(["lsp", "dap"]);
export type OmpToolConfigKind = z.infer<typeof OmpToolConfigKindSchema>;

export const MAX_TOOL_CONFIG_BYTES = 256 * 1024;

const stringList = z.array(z.string());
const object = z.record(z.string(), z.unknown());

const LspServerSchema = z
  .looseObject({
    command: z.string().min(1).optional(),
    args: stringList.optional(),
    fileTypes: stringList.optional(),
    languageId: z.string().optional(),
    rootMarkers: stringList.optional(),
    initOptions: object.optional(),
    settings: object.optional(),
    disabled: z.boolean().optional(),
    warmupTimeoutMs: z.number().optional(),
    isLinter: z.boolean().optional(),
    capabilities: z.record(z.string(), z.boolean()).optional(),
    workspaceReadyTimings: z.record(z.string(), z.number()).optional(),
  })
  .refine(
    (server) => !("resolvedCommand" in server) && !("createClient" in server),
    "resolvedCommand and createClient are owned by OMP and cannot be configured",
  );

const DapAdapterSchema = z.looseObject({
  command: z.string().min(1).optional(),
  args: stringList.optional(),
  languages: stringList.optional(),
  fileTypes: stringList.optional(),
  rootMarkers: stringList.optional(),
  launchDefaults: object.optional(),
  attachDefaults: object.optional(),
  connectMode: z.enum(["stdio", "socket", "tcp"]).optional(),
  acceptsDirectoryProgram: z.boolean().optional(),
  skipAttachRequest: z.boolean().optional(),
});

const LspFileSchema = z.looseObject({ idleTimeoutMs: z.number().optional() });

function describe(issue: z.core.$ZodIssue, prefix: string): string {
  const path = [prefix, ...issue.path.map(String)].filter(Boolean).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** OMP accepts a wrapper key or a flat map of entries. For lsp.json, mixing them silently drops the flat ones. */
function entriesOf(
  document: Record<string, unknown>,
  wrapper: "servers" | "adapters",
  ignoredKeys: readonly string[],
  rejectMixed: boolean,
): { entries: Record<string, unknown>; errors: string[] } {
  const wrapped = document[wrapper];
  if (wrapped === undefined) {
    const flat = Object.entries(document).filter(([key]) => !ignoredKeys.includes(key));
    return { entries: Object.fromEntries(flat), errors: [] };
  }
  if (!isObject(wrapped)) return { entries: {}, errors: [`${wrapper} must be an object`] };
  const stray = Object.keys(document).filter(
    (key) => key !== wrapper && !ignoredKeys.includes(key),
  );
  const errors =
    rejectMixed && stray.length > 0
      ? [`Do not mix ${wrapper} with entries at the top level (${stray.join(", ")})`]
      : [];
  return { entries: wrapped, errors };
}

/** Problems that make OMP ignore a definition, found before the file is written. Empty means valid. */
export function validateOmpToolConfig(kind: OmpToolConfigKind, text: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return [`Not valid JSON: ${error instanceof Error ? error.message : "parse error"}`];
  }
  if (!isObject(document)) return ["The file must hold a JSON object"];

  const wrapper = kind === "lsp" ? "servers" : "adapters";
  const ignoredKeys = kind === "lsp" ? ["idleTimeoutMs"] : [];
  const errors: string[] = [];
  if (kind === "lsp") {
    const top = LspFileSchema.safeParse(document);
    if (!top.success) errors.push(...top.error.issues.map((issue) => describe(issue, "")));
  }
  const { entries, errors: shapeErrors } = entriesOf(
    document,
    wrapper,
    ignoredKeys,
    kind === "lsp",
  );
  errors.push(...shapeErrors);
  const schema = kind === "lsp" ? LspServerSchema : DapAdapterSchema;
  for (const [name, entry] of Object.entries(entries)) {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((issue) => describe(issue, name)));
    }
  }
  return errors;
}

/** The debug adapters OMP ships. An override of one inherits its command. */
const BUILT_IN_DAP_ADAPTERS: ReadonlySet<string> = new Set([
  "gdb",
  "lldb-dap",
  "codelldb",
  "debugpy",
  "dlv",
  "js-debug-adapter",
  "netcoredbg",
  "kotlin-debug-adapter",
  "rdbg",
  "php-debug-adapter",
  "bash-debug-adapter",
  "dart-debug-adapter",
  "flutter-debug-adapter",
  "elixir-ls-debugger",
]);

/** The servers OMP ships. Any other name is a new definition, which OMP drops unless it is complete. */
const BUILT_IN_LSP_SERVERS: ReadonlySet<string> = new Set([
  "rust-analyzer",
  "clangd",
  "zls",
  "gopls",
  "typescript-language-server",
  "typescript-native",
  "denols",
  "biome",
  "eslint",
  "vscode-html-language-server",
  "vscode-css-language-server",
  "vscode-json-language-server",
  "tailwindcss",
  "svelte",
  "vue-language-server",
  "astro",
  "pyright",
  "basedpyright",
  "pylsp",
  "ty",
  "ruff",
  "jdtls",
  "kotlin-lsp",
  "metals",
  "hls",
  "ocamllsp",
  "elixirls",
  "expert",
  "erlangls",
  "gleam",
  "solargraph",
  "ruby-lsp",
  "rubocop",
  "bashls",
  "lua-language-server",
  "intelephense",
  "phpactor",
  "omnisharp",
  "yamlls",
  "terraformls",
  "dockerls",
  "helm-ls",
  "nixd",
  "nil",
  "ols",
  "dartls",
  "marksman",
  "texlab",
  "graphql",
  "prismals",
  "vimls",
  "emmet-language-server",
  "sourcekit-lsp",
  "swiftlint",
  "tlaplus",
]);

/**
 * Definitions that pass validation but that OMP drops: a server that is not built in needs a
 * command, file types and root markers (or extensionToLanguage, which supplies both).
 */
export function warnOmpToolConfig(kind: OmpToolConfigKind, text: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(document)) return [];
  const lsp = kind === "lsp";
  const { entries } = entriesOf(
    document,
    lsp ? "servers" : "adapters",
    lsp ? ["idleTimeoutMs"] : [],
    false,
  );
  const builtIn = lsp ? BUILT_IN_LSP_SERVERS : BUILT_IN_DAP_ADAPTERS;
  const ignored =
    !lsp && isObject(document.adapters)
      ? Object.keys(document).filter((key) => key !== "adapters")
      : [];
  const ignoredWarning =
    ignored.length > 0
      ? [`OMP ignores ${ignored.join(", ")} because adapters is present; move them inside adapters`]
      : [];
  return [
    ...ignoredWarning,
    ...Object.entries(entries).flatMap(([name, entry]) => {
      if (builtIn.has(name) || !isObject(entry)) return [];
      const derived = "extensionToLanguage" in entry;
      const missing = [
        typeof entry.command === "string" && entry.command ? null : "command",
        !lsp || derived || Array.isArray(entry.fileTypes) ? null : "fileTypes",
        !lsp || derived || Array.isArray(entry.rootMarkers) ? null : "rootMarkers",
      ].filter((field) => field !== null);
      return missing.length === 0
        ? []
        : [
            `${name} is not a built-in ${lsp ? "server" : "adapter"}, so OMP ignores it without ${missing.join(", ")}`,
          ];
    }),
  ];
}

const ToolConfigTargetSchema = z.object({
  store: OmpStoreSchema.optional(),
  /** A workspace folder selects its project file; without one the user file is used. */
  cwd: OmpWorkspaceCwdSchema.optional(),
  kind: OmpToolConfigKindSchema,
});

export const readOmpToolConfig = defineRpc({
  name: "paseo-omp.read-tool-config",
  input: ToolConfigTargetSchema.strict(),
  output: z.object({
    path: z.string(),
    exists: z.boolean(),
    text: z.string(),
    revision: z.string(),
    /** Sibling variants OMP also merges, such as lsp.yaml, which this editor does not change. */
    otherFiles: z.array(z.string()),
  }),
});

export const writeOmpToolConfig = defineRpc({
  name: "paseo-omp.write-tool-config",
  input: ToolConfigTargetSchema.extend({
    revision: z.string(),
    text: z.string().max(MAX_TOOL_CONFIG_BYTES),
  }).strict(),
  output: z.object({
    outcome: z.enum(["saved", "conflict", "invalid"]),
    errors: z.array(z.string()),
    /** Saved anyway, but OMP will not use these definitions. */
    warnings: z.array(z.string()),
    revision: z.string(),
  }),
});
