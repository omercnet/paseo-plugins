import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const MAX_OUTPUT_LENGTH = 192 * 1_024;
const MAX_PATH_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 512;
const MAX_QUERY_LENGTH = 1_024;

export const ContextModeProviderSchema = z.enum([
  "claude",
  "codex",
  "copilot",
  "cursor",
  "opencode",
  "pi",
  "omp",
  "omp-plugin",
]);

export const ContextModePlatformSchema = z.enum([
  "claude-code",
  "codex",
  "copilot-cli",
  "cursor",
  "opencode",
  "pi",
  "omp",
]);

const boundedLabel = z.string().trim().min(1).max(MAX_LABEL_LENGTH);
const boundedPattern = z.string().trim().min(1).max(256);
const absoluteLocalPath = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine(
    (value) =>
      !value.includes("\0") &&
      (value.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(value) ||
        /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)),
    { message: "path must be an absolute local path" },
  );
const providerScope = z
  .object({ provider: ContextModeProviderSchema, projectPath: absoluteLocalPath })
  .strict();
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "url must use HTTP or HTTPS");

export const KnowledgeToolResultSchema = z
  .object({
    provider: ContextModeProviderSchema,
    output: z.string().max(MAX_OUTPUT_LENGTH),
    completedAt: z.string().datetime(),
  })
  .strict();

export const SearchKnowledgeInputSchema = providerScope
  .extend({
    queries: z.array(z.string().trim().min(1).max(MAX_QUERY_LENGTH)).min(1).max(8),
    limit: z.number().int().min(1).max(10).default(3),
    source: boundedLabel.optional(),
    contentType: z.enum(["code", "prose"]).optional(),
    sort: z.enum(["relevance", "timeline"]).default("relevance"),
  })
  .strict();

export const IndexPathInputSchema = providerScope
  .extend({
    path: absoluteLocalPath,
    source: boundedLabel.optional(),
    include: z.array(boundedPattern).max(32).optional(),
    exclude: z.array(boundedPattern).max(32).optional(),
    maxDepth: z.number().int().min(0).max(20).optional(),
    maxFiles: z.number().int().min(1).max(1_000).optional(),
    extensions: z.array(boundedPattern).max(32).optional(),
    respectGitignore: z.boolean().optional(),
    followSymlinks: z.boolean().optional(),
  })
  .strict();

export const FetchAndIndexInputSchema = providerScope
  .extend({
    url: httpUrl,
    source: boundedLabel.optional(),
    force: z.boolean().default(false),
    ttl: z.number().int().min(0).max(1_209_600_000).optional(),
  })
  .strict();

const projectPurge = z
  .object({
    provider: ContextModeProviderSchema,
    projectPath: absoluteLocalPath,
    confirm: z.literal(true),
    scope: z.literal("project"),
  })
  .strict();
const sessionPurge = z
  .object({
    provider: ContextModeProviderSchema,
    projectPath: absoluteLocalPath,
    confirm: z.literal(true),
    scope: z.literal("session"),
    sessionId: z.string().trim().min(1).max(256),
  })
  .strict();

export const PurgeKnowledgeInputSchema = z.discriminatedUnion("scope", [
  projectPurge,
  sessionPurge,
]);

export const searchContextModeKnowledge = defineRpc({
  name: "context-mode.knowledge.search",
  input: SearchKnowledgeInputSchema,
  output: KnowledgeToolResultSchema,
});

export const indexContextModePath = defineRpc({
  name: "context-mode.knowledge.index-path",
  input: IndexPathInputSchema,
  output: KnowledgeToolResultSchema,
});

export const fetchAndIndexContextMode = defineRpc({
  name: "context-mode.knowledge.fetch-index",
  input: FetchAndIndexInputSchema,
  output: KnowledgeToolResultSchema,
});

export const purgeContextModeKnowledge = defineRpc({
  name: "context-mode.knowledge.purge",
  input: PurgeKnowledgeInputSchema,
  output: KnowledgeToolResultSchema,
});

export type ContextModeProvider = z.infer<typeof ContextModeProviderSchema>;
export type ContextModePlatform = z.infer<typeof ContextModePlatformSchema>;
export type KnowledgeToolResult = z.infer<typeof KnowledgeToolResultSchema>;
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInputSchema>;
export type IndexPathInput = z.infer<typeof IndexPathInputSchema>;
export type FetchAndIndexInput = z.infer<typeof FetchAndIndexInputSchema>;
export type PurgeKnowledgeInput = z.infer<typeof PurgeKnowledgeInputSchema>;
