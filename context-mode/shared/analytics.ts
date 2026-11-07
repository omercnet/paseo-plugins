import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_CONTEXT_MODE_DATABASE_USER_VERSION = 6 as const;

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();
const timestamp = z.string().datetime().nullable();

/** Byte totals of Context Mode tool calls: produced in the sandbox, returned to the agent, kept out. */
export const AnalyticsByteAccountingSchema = z
  .object({
    producedBytes: nonNegativeInteger,
    returnedBytes: nonNegativeInteger,
    savedBytes: nonNegativeInteger,
    indexedBytes: nonNegativeInteger,
  })
  .strict();

const savingsFields = {
  savedTokens: nonNegativeInteger,
  savingsPercent: nonNegativeNumber.max(100),
  byteAccounting: AnalyticsByteAccountingSchema,
};

export const AnalyticsTotalsSchema = z
  .object({
    agents: nonNegativeInteger,
    projects: nonNegativeInteger,
    sessions: nonNegativeInteger,
    events: nonNegativeInteger,
    toolCalls: nonNegativeInteger,
    indexedSources: nonNegativeInteger,
    indexedChunks: nonNegativeInteger,
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    ...savingsFields,
    lastActivityAt: timestamp,
  })
  .strict();

/** One row per Context Mode `--agent` id recorded in the databases (claude-code, codex, ...). */
export const AgentAnalyticsSchema = z
  .object({
    agent: z.string().min(1).max(128),
    projects: nonNegativeInteger,
    sessions: nonNegativeInteger,
    toolCalls: nonNegativeInteger,
    indexedSources: nonNegativeInteger,
    ...savingsFields,
  })
  .strict();

export const ProjectAnalyticsSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    worktrees: nonNegativeInteger,
    sessions: nonNegativeInteger,
    toolCalls: nonNegativeInteger,
    indexedSources: nonNegativeInteger,
    ...savingsFields,
    lastActivityAt: timestamp,
  })
  .strict();

/** Paseo provider whose Context Mode store holds the row, for Resume and Forget; null when none reaches it. */
const storeProvider = z.string().min(1).max(128).nullable();

/** One recorded agent session, newest first; the plugin's own `paseo-context-mode` calls are excluded. */
export const SessionAnalyticsSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    agent: z.string().min(1).max(128),
    projectPath: z.string().min(1).max(4_096),
    events: nonNegativeInteger,
    lastActivityAt: timestamp,
    provider: storeProvider,
  })
  .strict();

export const CategoryAnalyticsSchema = z
  .object({
    category: z.string().min(1).max(256),
    count: nonNegativeInteger,
    savedTokens: nonNegativeInteger,
  })
  .strict();

export const DailyAnalyticsSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    calls: nonNegativeInteger,
    savedTokens: nonNegativeInteger,
  })
  .strict();

export const IndexedSourceAnalyticsSchema = z
  .object({
    agent: z.string().min(1).max(128),
    projectPath: z.string().min(1).max(4_096),
    source: z.string().min(1).max(4_096),
    kind: z.enum(["path", "content", "url"]),
    chunks: nonNegativeInteger,
    indexedBytes: nonNegativeInteger,
    indexedAt: timestamp,
    provider: storeProvider,
  })
  .strict();

export const AnalyticsWarningSchema = z
  .object({
    code: z.enum([
      "storage-unavailable",
      "not-regular-database",
      "database-open-failed",
      "database-locked",
      "unsupported-schema",
      "database-query-failed",
      "result-truncated",
      "warning-limit",
    ]),
    project: z.string().min(1).max(128).optional(),
    message: z.string().min(1).max(512),
  })
  .strict();

export const ContextModeAnalyticsDashboardSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION),
    contextModeVersion: z.string().min(1).max(64).nullable(),
    completeness: z.enum(["complete", "partial", "unsupported"]),
    warnings: z.array(AnalyticsWarningSchema).max(20),
    totals: AnalyticsTotalsSchema,
    byAgent: z.array(AgentAnalyticsSchema).max(32),
    byProject: z.array(ProjectAnalyticsSchema).max(50),
    recentSessions: z.array(SessionAnalyticsSchema).max(20),
    byCategory: z.array(CategoryAnalyticsSchema).max(128),
    byDay: z.array(DailyAnalyticsSchema).max(400),
    sources: z.array(IndexedSourceAnalyticsSchema).max(2_000),
    generatedAt: z.string().datetime(),
  })
  .strict();

export const getContextModeAnalyticsDashboard = defineRpc({
  name: "context-mode.analytics-dashboard",
  input: z.object({}).strict(),
  output: ContextModeAnalyticsDashboardSchema,
});

export type AnalyticsByteAccounting = z.infer<typeof AnalyticsByteAccountingSchema>;
export type AnalyticsTotals = z.infer<typeof AnalyticsTotalsSchema>;
export type AgentAnalytics = z.infer<typeof AgentAnalyticsSchema>;
export type ProjectAnalytics = z.infer<typeof ProjectAnalyticsSchema>;
export type SessionAnalytics = z.infer<typeof SessionAnalyticsSchema>;
export type CategoryAnalytics = z.infer<typeof CategoryAnalyticsSchema>;
export type DailyAnalytics = z.infer<typeof DailyAnalyticsSchema>;
export type IndexedSourceAnalytics = z.infer<typeof IndexedSourceAnalyticsSchema>;
export type AnalyticsWarning = z.infer<typeof AnalyticsWarningSchema>;
export type ContextModeAnalyticsDashboard = z.infer<typeof ContextModeAnalyticsDashboardSchema>;
export type AnalyticsDashboard = ContextModeAnalyticsDashboard;
