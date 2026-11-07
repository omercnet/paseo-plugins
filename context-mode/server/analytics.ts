import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type {
  AgentAnalytics,
  AnalyticsByteAccounting,
  AnalyticsDashboard,
  AnalyticsWarning,
  IndexedSourceAnalytics,
  ProjectAnalytics,
  SessionAnalytics,
} from "../shared/analytics";
import { CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION } from "../shared/analytics";
import {
  CONTEXT_MODE_PROVIDERS,
  IN_PROCESS_PROVIDERS,
  providerForPlatform,
} from "../shared/providers";
import {
  ContextModeDatabaseError,
  type ContextModeDatabaseSnapshot,
  type DatabaseSavings,
  readContextModeDatabase,
} from "./database";
import { type ProviderOverrides, resolveProvider } from "./integration";
import {
  type ContextModeProjectDatabase,
  discoverContextModeDatabases,
  resolveContextModeDataDir,
} from "./storage-discovery";

const MAX_WARNINGS = 20;
const MAX_SOURCES = 2_000;
const MAX_AGENTS = 32;
const MAX_PROJECTS = 50;
const MAX_RECENT_SESSIONS = 20;
const MAX_CATEGORIES = 128;
const MAX_DAYS = 400;

interface MutableBytes extends DatabaseSavings {
  indexedBytes: number;
}

interface MutableAgent extends MutableBytes {
  agent: string;
  projects: number;
  sessions: number;
  indexedSources: number;
}

interface MutableSummary {
  count: number;
  savedBytes: number;
}

export interface ContextModeAnalyticsDependencies {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  discover?: typeof discoverContextModeDatabases;
  readDatabase?: (path: string) => ContextModeDatabaseSnapshot;
  /** Detected Context Mode runtime version; must resolve to null rather than reject. */
  resolveVersion?: () => Promise<string | null>;
  /** Paseo's configured providers; each may move its agents' data dir through its own env. */
  providers?: ProviderOverrides;
}

class WarningCollector {
  readonly items: AnalyticsWarning[] = [];
  #omitted = 0;

  add(warning: AnalyticsWarning): void {
    if (this.items.length < MAX_WARNINGS - 1) {
      this.items.push({
        ...warning,
        ...(warning.project ? { project: warning.project.slice(0, 128) } : {}),
        message: warning.message.slice(0, 512),
      });
    } else this.#omitted++;
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

function boundedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function emptyBytes(): MutableBytes {
  return { calls: 0, producedBytes: 0, returnedBytes: 0, savedBytes: 0, indexedBytes: 0 };
}

function addBytes(target: MutableBytes, source: MutableBytes): void {
  target.calls = boundedAdd(target.calls, source.calls);
  target.producedBytes = boundedAdd(target.producedBytes, source.producedBytes);
  target.returnedBytes = boundedAdd(target.returnedBytes, source.returnedBytes);
  target.savedBytes = boundedAdd(target.savedBytes, source.savedBytes);
  target.indexedBytes = boundedAdd(target.indexedBytes, source.indexedBytes);
}

function incrementSummary(
  summaries: Map<string, MutableSummary>,
  key: string,
  count: number,
  savedBytes: number,
): void {
  const current = summaries.get(key) ?? { count: 0, savedBytes: 0 };
  current.count = boundedAdd(current.count, count);
  current.savedBytes = boundedAdd(current.savedBytes, savedBytes);
  summaries.set(key, current);
}

/** Token estimate at 4 bytes per token; reduction is saved over produced, as `ctx_stats` reports. */
function savingsFields(bytes: MutableBytes): {
  savedTokens: number;
  savingsPercent: number;
  byteAccounting: AnalyticsByteAccounting;
} {
  const reduction = bytes.producedBytes > 0 ? bytes.savedBytes / bytes.producedBytes : 0;
  return {
    savedTokens: Math.floor(bytes.savedBytes / 4),
    savingsPercent: Math.min(100, Math.round(reduction * 1_000) / 10),
    byteAccounting: {
      producedBytes: bytes.producedBytes,
      returnedBytes: bytes.returnedBytes,
      savedBytes: bytes.savedBytes,
      indexedBytes: bytes.indexedBytes,
    },
  };
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

function databaseWarning(project: string, error: unknown): AnalyticsWarning {
  if (error instanceof ContextModeDatabaseError) {
    return { code: error.code, project: error.project, message: error.message };
  }
  return {
    code: "database-query-failed",
    project,
    message: "The database could not be inspected.",
  };
}

export async function collectContextModeAnalytics(
  dependencies: ContextModeAnalyticsDependencies = {},
): Promise<AnalyticsDashboard> {
  const discover = dependencies.discover ?? discoverContextModeDatabases;
  const readDatabase = dependencies.readDatabase ?? readContextModeDatabase;
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const providers = dependencies.providers ?? {};
  const dataDirOf = (id: string) =>
    resolveContextModeDataDir({ ...env, ...resolveProvider(id, providers).env }, home);
  // Symlinked aliases of one directory must not count its databases twice.
  const canonical = (dir: string) => realpath(dir).catch(() => dir);
  // A configured provider's own CONTEXT_MODE_DATA_DIR is where its injected agents write.
  const dataDirs = new Set(
    await Promise.all(
      [resolveContextModeDataDir(env, home), ...Object.keys(providers).map(dataDirOf)].map(
        canonical,
      ),
    ),
  );
  // Resume and Forget run through a provider, so each row names one that reaches its store,
  // preferring the provider that recorded it.
  const actionable = [
    ...CONTEXT_MODE_PROVIDERS.map((entry) => entry.provider),
    ...IN_PROCESS_PROVIDERS.map((entry) => entry.provider),
    ...Object.keys(providers).filter((id) => {
      const { base, platform } = resolveProvider(id, providers);
      return platform !== null || IN_PROCESS_PROVIDERS.some((entry) => entry.provider === base);
    }),
  ];
  const storeOf = new Map(
    await Promise.all(actionable.map(async (id) => [id, await canonical(dataDirOf(id))] as const)),
  );
  const storeProvider = (agent: string, dataDir: string): string | null => {
    const own = providerForPlatform(agent)?.provider;
    const candidates = own ? [own, ...actionable] : actionable;
    return candidates.find((id) => storeOf.get(id) === dataDir) ?? null;
  };
  const warnings = new WarningCollector();
  const databases: (ContextModeProjectDatabase & { dataDir: string })[] = [];
  for (const dataDir of dataDirs) {
    const discovery = await discover(dataDir);
    databases.push(...discovery.databases.map((database) => ({ ...database, dataDir })));
    for (const warning of discovery.warnings) warnings.add(warning);
  }

  const total = emptyBytes();
  let sessions = 0;
  let events = 0;
  let indexedSources = 0;
  let indexedChunks = 0;
  let lastActivityAt: string | null = null;
  const agents = new Map<string, MutableAgent>();
  const projects: ProjectAnalytics[] = [];
  const categories = new Map<string, MutableSummary>();
  const days = new Map<string, MutableSummary>();
  const sources: IndexedSourceAnalytics[] = [];
  const recentSessions: SessionAnalytics[] = [];
  let unsupportedSchema = false;

  for (const database of databases) {
    let snapshot: ContextModeDatabaseSnapshot;
    try {
      snapshot = readDatabase(database.path);
    } catch (error) {
      if (error instanceof ContextModeDatabaseError && error.code === "unsupported-schema") {
        unsupportedSchema = true;
      }
      warnings.add(databaseWarning(database.project, error));
      continue;
    }

    addBytes(total, snapshot);
    sessions = boundedAdd(sessions, snapshot.sessions);
    events = boundedAdd(events, snapshot.events);
    indexedSources = boundedAdd(indexedSources, snapshot.indexedSources);
    indexedChunks = boundedAdd(indexedChunks, snapshot.indexedChunks);
    lastActivityAt = laterTimestamp(lastActivityAt, snapshot.lastActivityAt);
    projects.push({
      path: snapshot.worktrees[0] ?? database.project,
      worktrees: snapshot.worktrees.length,
      sessions: snapshot.sessions,
      toolCalls: snapshot.calls,
      indexedSources: snapshot.indexedSources,
      ...savingsFields(snapshot),
      lastActivityAt: snapshot.lastActivityAt,
    });

    for (const summary of snapshot.byAgent) {
      const agent = agents.get(summary.agent) ?? {
        agent: summary.agent,
        projects: 0,
        sessions: 0,
        indexedSources: 0,
        ...emptyBytes(),
      };
      agent.projects = boundedAdd(agent.projects, 1);
      agent.sessions = boundedAdd(agent.sessions, summary.sessions);
      agent.indexedSources = boundedAdd(agent.indexedSources, summary.indexedSources);
      addBytes(agent, summary);
      agents.set(summary.agent, agent);
    }
    for (const tool of snapshot.byTool) {
      incrementSummary(categories, tool.tool, tool.calls, tool.savedBytes);
    }
    for (const day of snapshot.byDay) incrementSummary(days, day.date, day.calls, day.savedBytes);
    for (const source of snapshot.sources) {
      sources.push({
        agent: source.agent,
        projectPath: source.projectPath,
        source: source.label,
        kind: source.kind,
        chunks: source.chunks,
        indexedBytes: source.bytes,
        indexedAt: source.createdAt,
        provider: storeProvider(source.agent, database.dataDir),
      });
    }
    recentSessions.push(
      ...snapshot.sessionList.map((session) => ({
        ...session,
        provider: storeProvider(session.agent, database.dataDir),
      })),
    );
    for (const message of snapshot.truncated) {
      warnings.add({ code: "result-truncated", project: database.project, message });
    }
  }

  const allAgents = [...agents.values()]
    .sort(
      (left, right) => right.savedBytes - left.savedBytes || left.agent.localeCompare(right.agent),
    )
    .map(
      (agent): AgentAnalytics => ({
        agent: agent.agent,
        projects: agent.projects,
        sessions: agent.sessions,
        toolCalls: agent.calls,
        indexedSources: agent.indexedSources,
        ...savingsFields(agent),
      }),
    );
  const allCategories = [...categories]
    .map(([category, summary]) => ({
      category,
      count: summary.count,
      savedTokens: Math.floor(summary.savedBytes / 4),
    }))
    .sort(
      (left, right) =>
        right.savedTokens - left.savedTokens ||
        right.count - left.count ||
        left.category.localeCompare(right.category),
    );
  const allDays = [...days]
    .map(([date, summary]) => ({
      date,
      calls: summary.count,
      savedTokens: Math.floor(summary.savedBytes / 4),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  sources.sort(
    (left, right) =>
      (right.indexedAt ?? "").localeCompare(left.indexedAt ?? "") ||
      left.source.localeCompare(right.source),
  );
  recentSessions.sort(
    (left, right) =>
      (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "") ||
      left.sessionId.localeCompare(right.sessionId),
  );
  projects.sort(
    (left, right) =>
      right.byteAccounting.savedBytes - left.byteAccounting.savedBytes ||
      left.path.localeCompare(right.path),
  );
  for (const [count, maximum, label] of [
    [allAgents.length, MAX_AGENTS, "agent"],
    [allCategories.length, MAX_CATEGORIES, "tool"],
    [allDays.length, MAX_DAYS, "daily"],
    [sources.length, MAX_SOURCES, "indexed source"],
    [projects.length, MAX_PROJECTS, "project"],
  ] as const) {
    if (count > maximum) {
      warnings.add({
        code: "result-truncated",
        message: `Only the first ${maximum} ${label} analytics rows are included.`,
      });
    }
  }

  // A locked or unopenable store is a transient gap; only a schema mismatch warrants "update Context Mode".
  const unsupported = projects.length === 0 && unsupportedSchema;
  const coverage = warnings.hasWarnings ? "partial" : "complete";
  const contextModeVersion = dependencies.resolveVersion
    ? await dependencies.resolveVersion()
    : null;

  return {
    schemaVersion: CONTEXT_MODE_ANALYTICS_SCHEMA_VERSION,
    contextModeVersion,
    completeness: unsupported ? "unsupported" : coverage,
    warnings: warnings.finish(),
    totals: {
      agents: agents.size,
      projects: projects.length,
      sessions,
      events,
      toolCalls: total.calls,
      indexedSources,
      indexedChunks,
      inputTokens: Math.floor(total.producedBytes / 4),
      outputTokens: Math.floor(total.returnedBytes / 4),
      ...savingsFields(total),
      lastActivityAt,
    },
    byAgent: allAgents.slice(0, MAX_AGENTS),
    byProject: projects.slice(0, MAX_PROJECTS),
    recentSessions: recentSessions.slice(0, MAX_RECENT_SESSIONS),
    byCategory: allCategories.slice(0, MAX_CATEGORIES),
    byDay: allDays.slice(-MAX_DAYS),
    sources: sources.slice(0, MAX_SOURCES),
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
}
