import { basename } from "node:path";
import type {
  AnalyticsByteAccounting,
  AnalyticsDashboard,
  AnalyticsWarning,
  IndexedSourceAnalytics,
  ProviderAnalytics,
} from "../shared/analytics";
import {
  CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION,
  SUPPORTED_CONTEXT_MODE_DATABASE_VERSION,
} from "../shared/analytics";
import {
  ContextModeDatabaseError,
  type ContextModeDatabaseSnapshot,
  readContextModeDatabase,
  type SessionDatabaseSnapshot,
} from "./context-mode-db";
import {
  discoverContextModeStorageRoots,
  listRegularContextModeDatabases,
  type StorageDiscoveryOptions,
  type StorageDiscoveryResult,
} from "./storage-discovery";

const MAX_WARNINGS = 20;
const MAX_SOURCES = 2_000;
const MAX_PROVIDERS = 32;
const MAX_CATEGORIES = 128;
const MAX_DAYS = 400;

interface MutableByteAccounting {
  eventDataBytes: number;
  avoidedBytes: number;
  returnedBytes: number;
  snapshotBytes: number;
  indexedBytes: number;
}

interface MutableAggregate {
  databases: number;
  events: number;
  toolCalls: number;
  indexedSources: number;
  indexedChunks: number;
  sessions: Set<string>;
  projects: Set<string>;
  bytes: MutableByteAccounting;
}

interface MutableProviderAggregate extends MutableAggregate {
  provider: string;
}

interface MutableSummary {
  count: number;
  savedBytes: number;
}

interface MutableSource {
  provider: string;
  source: string;
  chunks: number;
  codeChunks: number;
  indexedBytes: number;
  indexedAt: string | null;
  state: "ready" | "empty" | "unavailable";
  detail?: string;
}

export interface ContextModeAnalyticsDependencies extends StorageDiscoveryOptions {
  now?: () => Date;
  discoverStorage?: (options?: StorageDiscoveryOptions) => Promise<StorageDiscoveryResult>;
  listDatabases?: typeof listRegularContextModeDatabases;
  readDatabase?: (path: string) => ContextModeDatabaseSnapshot;
}

class WarningCollector {
  readonly items: AnalyticsWarning[] = [];
  #omitted = 0;

  add(warning: AnalyticsWarning): void {
    const normalized: AnalyticsWarning = {
      ...warning,
      ...(warning.provider ? { provider: warning.provider.slice(0, 128) } : {}),
      ...(warning.database ? { database: warning.database.slice(0, 512) } : {}),
      message: warning.message.slice(0, 512),
    };
    if (this.items.length < MAX_WARNINGS - 1) this.items.push(normalized);
    else this.#omitted++;
  }

  finish(): AnalyticsWarning[] {
    if (this.#omitted > 0) {
      this.items.push({
        code: "warning-limit",
        message: `${this.#omitted} additional analytics warnings were omitted.`,
      });
    }
    return this.items;
  }

  get hasWarnings(): boolean {
    return this.items.length > 0 || this.#omitted > 0;
  }
}

function createAggregate(): MutableAggregate {
  return {
    databases: 0,
    events: 0,
    toolCalls: 0,
    indexedSources: 0,
    indexedChunks: 0,
    sessions: new Set<string>(),
    projects: new Set<string>(),
    bytes: {
      eventDataBytes: 0,
      avoidedBytes: 0,
      returnedBytes: 0,
      snapshotBytes: 0,
      indexedBytes: 0,
    },
  };
}

function boundedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function addBytes(target: MutableByteAccounting, source: Partial<MutableByteAccounting>): void {
  target.eventDataBytes = boundedAdd(target.eventDataBytes, source.eventDataBytes ?? 0);
  target.avoidedBytes = boundedAdd(target.avoidedBytes, source.avoidedBytes ?? 0);
  target.returnedBytes = boundedAdd(target.returnedBytes, source.returnedBytes ?? 0);
  target.snapshotBytes = boundedAdd(target.snapshotBytes, source.snapshotBytes ?? 0);
  target.indexedBytes = boundedAdd(target.indexedBytes, source.indexedBytes ?? 0);
}

function savedBytes(bytes: MutableByteAccounting): number {
  return [bytes.eventDataBytes, bytes.avoidedBytes, bytes.snapshotBytes, bytes.indexedBytes].reduce(
    boundedAdd,
    0,
  );
}

function byteAccounting(bytes: MutableByteAccounting): AnalyticsByteAccounting {
  return { ...bytes, savedBytes: savedBytes(bytes) };
}

function tokenFields(bytes: MutableByteAccounting): {
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPercent: number;
} {
  const saved = savedBytes(bytes);
  const possibleInput = boundedAdd(saved, bytes.returnedBytes);
  return {
    inputTokens: Math.floor(possibleInput / 4),
    outputTokens: Math.floor(bytes.returnedBytes / 4),
    savedTokens: Math.floor(saved / 4),
    savingsPercent: possibleInput > 0 ? Math.round((saved / possibleInput) * 1_000) / 10 : 0,
  };
}

function incrementSummary(
  summaries: Map<string, MutableSummary>,
  key: string,
  count: number,
  bytes: number,
): void {
  const current = summaries.get(key) ?? { count: 0, savedBytes: 0 };
  current.count = boundedAdd(current.count, count);
  current.savedBytes = boundedAdd(current.savedBytes, bytes);
  summaries.set(key, current);
}

function mergeSessionSnapshot(
  target: MutableAggregate,
  snapshot: SessionDatabaseSnapshot,
  sessionNamespace: string,
  categoryTotals?: Map<string, MutableSummary>,
  dayTotals?: Map<string, MutableSummary>,
): void {
  target.events = boundedAdd(target.events, snapshot.events);
  target.toolCalls = boundedAdd(target.toolCalls, snapshot.toolCalls);
  addBytes(target.bytes, snapshot);
  for (const session of snapshot.sessions) target.sessions.add(`${sessionNamespace}\0${session}`);
  for (const project of snapshot.projects) target.projects.add(project);
  if (categoryTotals) {
    for (const category of snapshot.byCategory) {
      incrementSummary(categoryTotals, category.category, category.count, category.savedBytes);
    }
  }
  if (dayTotals) {
    for (const day of snapshot.byDay) {
      incrementSummary(dayTotals, day.date, day.calls, day.savedBytes);
    }
  }
}

function mergeSource(target: Map<string, MutableSource>, source: MutableSource): void {
  const key = `${source.provider}\0${source.source}`;
  const current = target.get(key);
  if (!current) {
    target.set(key, source);
    return;
  }
  current.chunks = boundedAdd(current.chunks, source.chunks);
  current.codeChunks = boundedAdd(current.codeChunks, source.codeChunks);
  current.indexedBytes = boundedAdd(current.indexedBytes, source.indexedBytes);
  if (source.indexedAt && (!current.indexedAt || source.indexedAt > current.indexedAt)) {
    current.indexedAt = source.indexedAt;
  }
  if (source.state === "ready") current.state = "ready";
  else if (source.state === "unavailable" && current.state === "empty")
    current.state = "unavailable";
  if (!current.detail && source.detail) current.detail = source.detail;
}

function providerOutput(aggregate: MutableProviderAggregate): ProviderAnalytics {
  return {
    provider: aggregate.provider,
    databases: aggregate.databases,
    projects: aggregate.projects.size,
    sessions: aggregate.sessions.size,
    events: aggregate.events,
    toolCalls: aggregate.toolCalls,
    indexedSources: aggregate.indexedSources,
    indexedChunks: aggregate.indexedChunks,
    ...tokenFields(aggregate.bytes),
    byteAccounting: byteAccounting(aggregate.bytes),
  };
}

function databaseWarning(provider: string, path: string, error: unknown): AnalyticsWarning {
  if (error instanceof ContextModeDatabaseError) {
    return {
      code: error.code,
      provider,
      database: error.database,
      message: error.message,
    };
  }
  return {
    code: "database-query-failed",
    provider,
    database: basename(path),
    message: "The database could not be inspected.",
  };
}

export async function collectContextModeAnalytics(
  dependencies: ContextModeAnalyticsDependencies = {},
): Promise<AnalyticsDashboard> {
  const discoverStorage = dependencies.discoverStorage ?? discoverContextModeStorageRoots;
  const listDatabases = dependencies.listDatabases ?? listRegularContextModeDatabases;
  const readDatabase = dependencies.readDatabase ?? readContextModeDatabase;
  const warningCollector = new WarningCollector();
  const discovery = await discoverStorage({ home: dependencies.home, env: dependencies.env });
  for (const warning of discovery.warnings) warningCollector.add(warning);

  const total = createAggregate();
  const providers: MutableProviderAggregate[] = [];
  const categories = new Map<string, MutableSummary>();
  const days = new Map<string, MutableSummary>();
  const sourceMap = new Map<string, MutableSource>();
  let attemptedDatabases = 0;
  let successfulDatabases = 0;

  for (const root of discovery.roots) {
    const provider: MutableProviderAggregate = { provider: root.provider, ...createAggregate() };
    providers.push(provider);

    for (const [directoryKind, directory] of [
      ["session", root.sessionsDir],
      ["content", root.contentDir],
    ] as const) {
      const listing = await listDatabases(root.provider, directory);
      for (const warning of listing.warnings) warningCollector.add(warning);

      for (const path of listing.files) {
        attemptedDatabases++;
        try {
          const snapshot = readDatabase(path);
          successfulDatabases++;
          total.databases = boundedAdd(total.databases, 1);
          provider.databases = boundedAdd(provider.databases, 1);

          if (snapshot.kind === "session") {
            mergeSessionSnapshot(total, snapshot, root.provider, categories, days);
            mergeSessionSnapshot(provider, snapshot, root.provider);
            continue;
          }

          total.indexedSources = boundedAdd(total.indexedSources, snapshot.sources.length);
          total.indexedChunks = boundedAdd(total.indexedChunks, snapshot.chunks);
          provider.indexedSources = boundedAdd(provider.indexedSources, snapshot.sources.length);
          provider.indexedChunks = boundedAdd(provider.indexedChunks, snapshot.chunks);
          addBytes(total.bytes, { indexedBytes: snapshot.indexedBytes });
          addBytes(provider.bytes, { indexedBytes: snapshot.indexedBytes });
          for (const day of snapshot.byDay) {
            incrementSummary(days, day.date, day.calls, day.savedBytes);
          }
          for (const source of snapshot.sources) {
            mergeSource(sourceMap, {
              provider: root.provider,
              source: source.source,
              chunks: source.chunks,
              codeChunks: source.codeChunks,
              indexedBytes: source.indexedBytes,
              indexedAt: source.indexedAt,
              state: source.chunks > 0 ? "ready" : "empty",
              ...(source.detail ? { detail: source.detail } : {}),
            });
          }
          for (const message of snapshot.inconsistencies) {
            warningCollector.add({
              code: "inconsistent-index",
              provider: root.provider,
              database: basename(path),
              message,
            });
          }
        } catch (error) {
          const warning = databaseWarning(root.provider, path, error);
          warningCollector.add(warning);
          if (directoryKind === "content") {
            mergeSource(sourceMap, {
              provider: root.provider,
              source: `[database] ${basename(path)}`,
              chunks: 0,
              codeChunks: 0,
              indexedBytes: 0,
              indexedAt: null,
              state: "unavailable",
              detail: warning.message,
            });
          }
        }
      }
    }
  }

  const allSources = [...sourceMap.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.source.localeCompare(right.source),
  );
  if (allSources.length > MAX_SOURCES) {
    warningCollector.add({
      code: "result-truncated",
      message: `Only the first ${MAX_SOURCES} indexed sources are included in the dashboard.`,
    });
  }
  const sources: IndexedSourceAnalytics[] = allSources.slice(0, MAX_SOURCES);
  const allProviders = providers.map(providerOutput);
  const allCategories = [...categories]
    .map(([category, summary]) => ({
      category,
      count: summary.count,
      savedTokens: Math.floor(summary.savedBytes / 4),
    }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
  const allDays = [...days]
    .map(([date, summary]) => ({
      date,
      calls: summary.count,
      savedTokens: Math.floor(summary.savedBytes / 4),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  for (const [count, maximum, label] of [
    [allProviders.length, MAX_PROVIDERS, "provider"],
    [allCategories.length, MAX_CATEGORIES, "category"],
    [allDays.length, MAX_DAYS, "daily"],
  ] as const) {
    if (count > maximum) {
      warningCollector.add({
        code: "result-truncated",
        message: `Only the first ${maximum} ${label} analytics rows are included.`,
      });
    }
  }
  const byProvider = allProviders.slice(0, MAX_PROVIDERS);
  const byCategory = allCategories.slice(0, MAX_CATEGORIES);
  const byDay = allDays.slice(-MAX_DAYS);
  const hadWarnings = warningCollector.hasWarnings;
  const completeness =
    attemptedDatabases > 0 && successfulDatabases === 0
      ? "unsupported"
      : hadWarnings
        ? "partial"
        : "complete";
  const warnings = warningCollector.finish();

  return {
    schemaVersion: CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION,
    contextModeVersion: SUPPORTED_CONTEXT_MODE_DATABASE_VERSION,
    completeness,
    warnings,
    totals: {
      providers: providers.length,
      databases: total.databases,
      projects: total.projects.size,
      sessions: total.sessions.size,
      events: total.events,
      toolCalls: total.toolCalls,
      indexedSources: total.indexedSources,
      indexedChunks: total.indexedChunks,
      ...tokenFields(total.bytes),
      byteAccounting: byteAccounting(total.bytes),
    },
    byProvider,
    byCategory,
    byDay,
    sources,
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
}

export function createContextModeAnalyticsHandler(
  dependencies: ContextModeAnalyticsDependencies = {},
): (_input: Record<string, never>) => Promise<AnalyticsDashboard> {
  return async () => collectContextModeAnalytics(dependencies);
}
