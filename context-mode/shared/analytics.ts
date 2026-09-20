import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_CONTEXT_MODE_DATABASE_VERSION = "1.0.169" as const;

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();

export const AnalyticsByteAccountingSchema = z
  .object({
    eventDataBytes: nonNegativeInteger,
    avoidedBytes: nonNegativeInteger,
    returnedBytes: nonNegativeInteger,
    snapshotBytes: nonNegativeInteger,
    indexedBytes: nonNegativeInteger,
    savedBytes: nonNegativeInteger,
  })
  .strict();

export const AnalyticsTotalsSchema = z
  .object({
    providers: nonNegativeInteger,
    databases: nonNegativeInteger,
    projects: nonNegativeInteger,
    sessions: nonNegativeInteger,
    events: nonNegativeInteger,
    toolCalls: nonNegativeInteger,
    indexedSources: nonNegativeInteger,
    indexedChunks: nonNegativeInteger,
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    savedTokens: nonNegativeInteger,
    savingsPercent: nonNegativeNumber.max(100),
    byteAccounting: AnalyticsByteAccountingSchema,
  })
  .strict();

export const ProviderAnalyticsSchema = z
  .object({
    provider: z.string().min(1).max(128),
    databases: nonNegativeInteger,
    projects: nonNegativeInteger,
    sessions: nonNegativeInteger,
    events: nonNegativeInteger,
    toolCalls: nonNegativeInteger,
    indexedSources: nonNegativeInteger,
    indexedChunks: nonNegativeInteger,
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    savedTokens: nonNegativeInteger,
    savingsPercent: nonNegativeNumber.max(100),
    byteAccounting: AnalyticsByteAccountingSchema,
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
    provider: z.string().min(1).max(128),
    source: z.string().min(1).max(4_096),
    chunks: nonNegativeInteger,
    codeChunks: nonNegativeInteger,
    indexedBytes: nonNegativeInteger,
    indexedAt: z.string().nullable(),
    state: z.enum(["ready", "empty", "unavailable"]),
    detail: z.string().max(512).optional(),
  })
  .strict();

export const AnalyticsWarningSchema = z
  .object({
    code: z.enum([
      "invalid-storage-root",
      "storage-unavailable",
      "not-regular-database",
      "database-open-failed",
      "unsupported-schema",
      "database-query-failed",
      "inconsistent-index",
      "result-truncated",
      "warning-limit",
    ]),
    provider: z.string().min(1).max(128).optional(),
    database: z.string().min(1).max(512).optional(),
    message: z.string().min(1).max(512),
  })
  .strict();

export const ContextModeAnalyticsDashboardSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION),
    contextModeVersion: z.literal(SUPPORTED_CONTEXT_MODE_DATABASE_VERSION),
    completeness: z.enum(["complete", "partial", "unsupported"]),
    warnings: z.array(AnalyticsWarningSchema).max(20),
    totals: AnalyticsTotalsSchema,
    byProvider: z.array(ProviderAnalyticsSchema).max(32),
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
export type ProviderAnalytics = z.infer<typeof ProviderAnalyticsSchema>;
export type CategoryAnalytics = z.infer<typeof CategoryAnalyticsSchema>;
export type DailyAnalytics = z.infer<typeof DailyAnalyticsSchema>;
export type IndexedSourceAnalytics = z.infer<typeof IndexedSourceAnalyticsSchema>;
export type AnalyticsWarning = z.infer<typeof AnalyticsWarningSchema>;
export type ContextModeAnalyticsDashboard = z.infer<typeof ContextModeAnalyticsDashboardSchema>;
export type AnalyticsDashboard = ContextModeAnalyticsDashboard;
