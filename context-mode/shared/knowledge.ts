import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const MAX_OUTPUT_LENGTH = 192 * 1_024;
const MAX_PATH_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 512;
const MAX_QUERY_LENGTH = 1_024;

export const ContextModeProviderSchema = z.enum(["claude", "codex", "copilot", "opencode"]);

export const ContextModePlatformSchema = z.enum([
  "claude-code",
  "codex",
  "copilot-cli",
  "opencode",
]);

/** A Paseo provider id: a built-in or one configured in `agents.providers`. */
export const KnowledgeProviderSchema = z.string().trim().min(1).max(128);

const boundedLabel = z.string().trim().min(1).max(MAX_LABEL_LENGTH);
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
  .object({ provider: KnowledgeProviderSchema, projectPath: absoluteLocalPath })
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
    provider: KnowledgeProviderSchema,
    output: z.string().max(MAX_OUTPUT_LENGTH),
    completedAt: z.string().datetime(),
  })
  .strict();

const pageCursor = z.number().int().nonnegative();

/** Where the next page starts: `offset` for relevance order, `after` (epoch ms) for timeline. */
export const SearchPageSchema = z.union([
  z.object({ offset: pageCursor }).strict(),
  z.object({ after: pageCursor }).strict(),
]);

export const SearchKnowledgeResultSchema = KnowledgeToolResultSchema.extend({
  next: SearchPageSchema.nullable(),
}).strict();

export const SearchKnowledgeInputSchema = providerScope
  .extend({
    queries: z.array(z.string().trim().min(1).max(MAX_QUERY_LENGTH)).min(1).max(8),
    scope: z.enum(["worktree", "project"]).default("worktree"),
    source: boundedLabel.optional(),
    sort: z.enum(["relevance", "timeline"]).default("relevance"),
    page: SearchPageSchema.optional(),
  })
  .strict();

export const IndexPathInputSchema = providerScope.extend({ path: absoluteLocalPath }).strict();

export const FetchAndIndexInputSchema = providerScope.extend({ url: httpUrl }).strict();

export const ResumeSessionInputSchema = providerScope
  .extend({ sessionId: z.string().trim().min(1).max(256) })
  .strict();

const purgeBase = {
  provider: KnowledgeProviderSchema,
  projectPath: absoluteLocalPath,
  confirm: z.literal(true),
};

export const PurgeKnowledgeInputSchema = z.discriminatedUnion("scope", [
  z.object({ ...purgeBase, scope: z.literal("project") }).strict(),
  z
    .object({
      ...purgeBase,
      scope: z.literal("session"),
      sessionId: z.string().trim().min(1).max(256),
    })
    .strict(),
  z.object({ ...purgeBase, scope: z.literal("source"), source: boundedLabel }).strict(),
]);

export const searchContextModeKnowledge = defineRpc({
  name: "context-mode.knowledge.search",
  input: SearchKnowledgeInputSchema,
  output: SearchKnowledgeResultSchema,
});

/** `ctx_resume` for one recorded session: the state block an agent gets after a compact or restart. */
export const resumeContextModeSession = defineRpc({
  name: "context-mode.knowledge.resume",
  input: ResumeSessionInputSchema,
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
export type SearchPage = z.infer<typeof SearchPageSchema>;
export type SearchKnowledgeResult = z.infer<typeof SearchKnowledgeResultSchema>;
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInputSchema>;
export type IndexPathInput = z.infer<typeof IndexPathInputSchema>;
export type FetchAndIndexInput = z.infer<typeof FetchAndIndexInputSchema>;
export type ResumeSessionInput = z.infer<typeof ResumeSessionInputSchema>;
export type PurgeKnowledgeInput = z.infer<typeof PurgeKnowledgeInputSchema>;
