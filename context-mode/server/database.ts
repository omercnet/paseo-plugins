import { lstatSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SUPPORTED_CONTEXT_MODE_DATABASE_USER_VERSION } from "../shared/analytics";
import { PLUGIN_SESSION_ID } from "./mcp-process";

const BUSY_TIMEOUT_MS = 150;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_AGENT_ROWS = 256;
const MAX_TOOL_ROWS = 512;
const MAX_DAY_ROWS = 400;
const MAX_WORKTREE_ROWS = 64;
const MAX_SOURCE_ROWS = 2_000;
const MAX_SESSION_ROWS = 20;
const MS_PER_DAY = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

const REQUIRED_SCHEMA: Record<string, readonly string[]> = {
  events: [
    "session_id",
    "worktree",
    "agent",
    "kind",
    "tool",
    "sandbox_bytes",
    "returned_bytes",
    "created_at",
  ],
  sources: ["id", "worktree", "agent", "kind", "label", "bytes_total", "chunk_count", "created_ts"],
};

/** Mirrors upstream `ctx_stats`: tool calls, excluding cost rows and ctx_stats itself. */
const CALL = "tool IS NOT NULL AND kind <> 'cost' AND tool <> 'ctx_stats'";
/** The panel's own calls (search, index, resume, forget) are not agent work and stay out of every figure. */
const AGENT_WORK = `session_id <> '${PLUGIN_SESSION_ID}'`;
/** Mirrors upstream `ctx_stats` event kinds: cost rows and ctx_stats itself are bookkeeping. */
const EVENT_COUNT =
  "SUM(CASE WHEN kind <> 'cost' AND (tool IS NULL OR tool <> 'ctx_stats') THEN 1 ELSE 0 END)";
/** Savings are clamped per (session, agent), exactly as `ctx_stats` sums its scope rows. */
const SESSION_GROUPS = `SELECT
    session_id,
    agent,
    ${EVENT_COUNT} AS events,
    SUM(CASE WHEN ${CALL} THEN 1 ELSE 0 END) AS calls,
    SUM(CASE WHEN ${CALL} THEN sandbox_bytes ELSE 0 END) AS produced,
    SUM(CASE WHEN ${CALL} THEN returned_bytes ELSE 0 END) AS returned,
    MAX(created_at) AS last
  FROM events
  WHERE ${AGENT_WORK}
  GROUP BY session_id, agent`;
const SAVINGS_COLUMNS = `COALESCE(SUM(calls), 0) AS calls,
    COALESCE(SUM(produced), 0) AS produced,
    COALESCE(SUM(returned), 0) AS returned,
    COALESCE(SUM(MAX(0, produced - returned)), 0) AS saved`;
const TOTALS = `SELECT
    COUNT(DISTINCT session_id) AS sessions,
    COALESCE(SUM(events), 0) AS events,
    ${SAVINGS_COLUMNS},
    MAX(last) AS last
  FROM (${SESSION_GROUPS})`;
const BY_AGENT = `SELECT
    agent,
    COUNT(DISTINCT session_id) AS sessions,
    ${SAVINGS_COLUMNS}
  FROM (${SESSION_GROUPS})
  GROUP BY agent
  ORDER BY saved DESC, agent
  LIMIT ?`;
const SOURCE_TOTALS = `SELECT
    COUNT(*) AS sources,
    COALESCE(SUM(chunk_count), 0) AS chunks,
    COALESCE(SUM(bytes_total), 0) AS bytes,
    MAX(created_ts) AS last
  FROM sources`;
const SOURCES_BY_AGENT = `SELECT agent, COUNT(*) AS sources, COALESCE(SUM(bytes_total), 0) AS bytes
  FROM sources
  GROUP BY agent
  ORDER BY sources DESC, agent
  LIMIT ?`;
const BY_TOOL = `SELECT
    tool,
    COUNT(*) AS calls,
    MAX(0, SUM(sandbox_bytes) - SUM(returned_bytes)) AS saved
  FROM events
  WHERE ${CALL} AND ${AGENT_WORK}
  GROUP BY tool
  ORDER BY saved DESC, calls DESC, tool
  LIMIT ?`;
const BY_DAY = `SELECT day, SUM(calls) AS calls, SUM(saved) AS saved
  FROM (
    SELECT
      created_at / ${MS_PER_DAY} AS day,
      COUNT(*) AS calls,
      MAX(0, SUM(sandbox_bytes) - SUM(returned_bytes)) AS saved
    FROM events
    WHERE ${CALL} AND ${AGENT_WORK}
    GROUP BY day, tool
  )
  GROUP BY day
  ORDER BY day DESC
  LIMIT ?`;
const WORKTREES = `SELECT worktree, MAX(at) AS last
  FROM (
    SELECT worktree, created_at AS at FROM events WHERE ${AGENT_WORK}
    UNION ALL
    SELECT worktree, created_ts AS at FROM sources
  )
  GROUP BY worktree
  ORDER BY last DESC, worktree
  LIMIT ?`;
const SOURCES = `SELECT agent, worktree, label, kind, bytes_total, chunk_count, created_ts
  FROM sources
  ORDER BY created_ts DESC, id DESC
  LIMIT ?`;
const RECENT_SESSIONS = `SELECT session_id, agent, worktree, ${EVENT_COUNT} AS events, MAX(created_at) AS last
  FROM events
  WHERE ${AGENT_WORK}
  GROUP BY session_id, agent, worktree
  ORDER BY last DESC
  LIMIT ?`;

type DatabaseRow = Record<string, unknown>;

export type ContextModeDatabaseErrorCode =
  | "not-regular-database"
  | "database-open-failed"
  | "database-locked"
  | "unsupported-schema"
  | "database-query-failed";

export class ContextModeDatabaseError extends Error {
  readonly code: ContextModeDatabaseErrorCode;
  /** The project key directory holding the database. */
  readonly project: string;

  constructor(code: ContextModeDatabaseErrorCode, path: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ContextModeDatabaseError";
    this.code = code;
    this.project = basename(dirname(path));
  }
}

export interface DatabaseSavings {
  calls: number;
  producedBytes: number;
  returnedBytes: number;
  savedBytes: number;
}

export interface DatabaseAgentSummary extends DatabaseSavings {
  agent: string;
  sessions: number;
  indexedSources: number;
  indexedBytes: number;
}

export interface DatabaseToolSummary {
  tool: string;
  calls: number;
  savedBytes: number;
}

export interface DatabaseDaySummary {
  date: string;
  calls: number;
  savedBytes: number;
}

export type DatabaseSourceKind = "path" | "content" | "url";

export interface DatabaseSourceSnapshot {
  agent: string;
  projectPath: string;
  label: string;
  kind: DatabaseSourceKind;
  bytes: number;
  chunks: number;
  createdAt: string | null;
}

export interface DatabaseSessionSnapshot {
  sessionId: string;
  agent: string;
  projectPath: string;
  events: number;
  lastActivityAt: string | null;
}

export interface ContextModeDatabaseSnapshot extends DatabaseSavings {
  /** Worktree paths recorded in the database, most recently active first. */
  worktrees: string[];
  sessions: number;
  events: number;
  indexedSources: number;
  indexedChunks: number;
  indexedBytes: number;
  lastActivityAt: string | null;
  byAgent: DatabaseAgentSummary[];
  byTool: DatabaseToolSummary[];
  byDay: DatabaseDaySummary[];
  sources: DatabaseSourceSnapshot[];
  /** Most recently active sessions, excluding the plugin's own calls. */
  sessionList: DatabaseSessionSnapshot[];
  /** Human-readable notes for result sets cut at their row limit. */
  truncated: string[];
}

function nonNegativeInteger(value: unknown): number {
  const numeric = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric));
}

function boundedText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum);
}

function isSourceKind(value: unknown): value is DatabaseSourceKind {
  return value === "path" || value === "url" || value === "content";
}

function isoFromMilliseconds(value: unknown): string | null {
  const milliseconds = nonNegativeInteger(value);
  if (milliseconds === 0 || milliseconds > MAX_DATE_MS) return null;
  return new Date(milliseconds).toISOString();
}

function savings(row: DatabaseRow): DatabaseSavings {
  return {
    calls: nonNegativeInteger(row.calls),
    producedBytes: nonNegativeInteger(row.produced),
    returnedBytes: nonNegativeInteger(row.returned),
    savedBytes: nonNegativeInteger(row.saved),
  };
}

function assertRequiredSchema(database: DatabaseSync, path: string): void {
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    const rows = database.prepare(`PRAGMA table_xinfo('${table}')`).all() as DatabaseRow[];
    const columns = new Set(rows.map((row) => row.name));
    if (columns.size === 0) {
      throw new ContextModeDatabaseError(
        "unsupported-schema",
        path,
        `Unsupported Context Mode schema: missing ${table}.`,
      );
    }
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new ContextModeDatabaseError(
        "unsupported-schema",
        path,
        `Unsupported Context Mode schema: ${table} is missing ${missing.join(", ")}.`,
      );
    }
  }
}

function limited(rows: DatabaseRow[], maximum: number, label: string, truncated: string[]) {
  if (rows.length > maximum) truncated.push(`Only the first ${maximum} ${label} were read.`);
  return rows.slice(0, maximum);
}

function readSnapshot(database: DatabaseSync): ContextModeDatabaseSnapshot {
  const truncated: string[] = [];
  const totals = database.prepare(TOTALS).get() as DatabaseRow;
  const sourceTotals = database.prepare(SOURCE_TOTALS).get() as DatabaseRow;

  const agentRows = database.prepare(BY_AGENT).all(MAX_AGENT_ROWS + 1) as DatabaseRow[];
  const byAgent = new Map<string, DatabaseAgentSummary>();
  for (const row of limited(agentRows, MAX_AGENT_ROWS, "agents", truncated)) {
    const agent = boundedText(row.agent, "unknown", 128);
    byAgent.set(agent, {
      agent,
      sessions: nonNegativeInteger(row.sessions),
      ...savings(row),
      indexedSources: 0,
      indexedBytes: 0,
    });
  }
  const sourceAgentRows = database
    .prepare(SOURCES_BY_AGENT)
    .all(MAX_AGENT_ROWS + 1) as DatabaseRow[];
  for (const row of limited(sourceAgentRows, MAX_AGENT_ROWS, "source agents", truncated)) {
    const agent = boundedText(row.agent, "unknown", 128);
    const summary = byAgent.get(agent) ?? {
      agent,
      sessions: 0,
      calls: 0,
      producedBytes: 0,
      returnedBytes: 0,
      savedBytes: 0,
      indexedSources: 0,
      indexedBytes: 0,
    };
    summary.indexedSources = nonNegativeInteger(row.sources);
    summary.indexedBytes = nonNegativeInteger(row.bytes);
    byAgent.set(agent, summary);
  }

  const toolRows = database.prepare(BY_TOOL).all(MAX_TOOL_ROWS + 1) as DatabaseRow[];
  const byTool = limited(toolRows, MAX_TOOL_ROWS, "tools", truncated).map((row) => ({
    tool: boundedText(row.tool, "unknown", 256),
    calls: nonNegativeInteger(row.calls),
    savedBytes: nonNegativeInteger(row.saved),
  }));

  const dayRows = database.prepare(BY_DAY).all(MAX_DAY_ROWS) as DatabaseRow[];
  const byDay = dayRows.flatMap((row) => {
    const date = isoFromMilliseconds(nonNegativeInteger(row.day) * MS_PER_DAY)?.slice(0, 10);
    if (!date) return [];
    return [
      { date, calls: nonNegativeInteger(row.calls), savedBytes: nonNegativeInteger(row.saved) },
    ];
  });

  const worktreeRows = database.prepare(WORKTREES).all(MAX_WORKTREE_ROWS + 1) as DatabaseRow[];
  const worktrees = limited(worktreeRows, MAX_WORKTREE_ROWS, "worktrees", truncated).flatMap(
    (row) => {
      const path = boundedText(row.worktree, "", 4_096);
      return path ? [path] : [];
    },
  );

  const sourceRows = database.prepare(SOURCES).all(MAX_SOURCE_ROWS + 1) as DatabaseRow[];
  const sources = limited(sourceRows, MAX_SOURCE_ROWS, "indexed sources", truncated).map((row) => ({
    agent: boundedText(row.agent, "unknown", 128),
    projectPath: boundedText(row.worktree, "unknown", 4_096),
    label: boundedText(row.label, "(unnamed source)", 4_096),
    kind: isSourceKind(row.kind) ? row.kind : "content",
    bytes: nonNegativeInteger(row.bytes_total),
    chunks: nonNegativeInteger(row.chunk_count),
    createdAt: isoFromMilliseconds(row.created_ts),
  }));

  const sessionRows = database.prepare(RECENT_SESSIONS).all(MAX_SESSION_ROWS) as DatabaseRow[];
  const sessionList = sessionRows.map((row) => ({
    sessionId: boundedText(row.session_id, "unknown", 256),
    agent: boundedText(row.agent, "unknown", 128),
    projectPath: boundedText(row.worktree, "unknown", 4_096),
    events: nonNegativeInteger(row.events),
    lastActivityAt: isoFromMilliseconds(row.last),
  }));

  const lastActivity = Math.max(
    nonNegativeInteger(totals.last),
    nonNegativeInteger(sourceTotals.last),
  );
  return {
    worktrees,
    sessions: nonNegativeInteger(totals.sessions),
    events: nonNegativeInteger(totals.events),
    ...savings(totals),
    indexedSources: nonNegativeInteger(sourceTotals.sources),
    indexedChunks: nonNegativeInteger(sourceTotals.chunks),
    indexedBytes: nonNegativeInteger(sourceTotals.bytes),
    lastActivityAt: isoFromMilliseconds(lastActivity),
    byAgent: [...byAgent.values()],
    byTool,
    byDay,
    sources,
    sessionList,
    truncated,
  };
}

function classifyDatabaseError(error: unknown): ContextModeDatabaseErrorCode {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("database is locked") || message.includes("database is busy")) {
    return "database-locked";
  }
  if (
    message.includes("not a database") ||
    message.includes("database disk image is malformed") ||
    message.includes("unable to open database")
  ) {
    return "database-open-failed";
  }
  return "database-query-failed";
}

const ERROR_MESSAGES: Record<ContextModeDatabaseErrorCode, string> = {
  "not-regular-database": "The database is not a regular file.",
  "database-open-failed": "The database could not be opened read-only.",
  "database-locked": "The database is locked by a writer; try again shortly.",
  "unsupported-schema": "Unsupported Context Mode schema.",
  "database-query-failed": "The database could not be queried safely.",
};

function wrapError(error: unknown, path: string): ContextModeDatabaseError {
  if (error instanceof ContextModeDatabaseError) return error;
  const code = classifyDatabaseError(error);
  return new ContextModeDatabaseError(code, path, ERROR_MESSAGES[code], error);
}

/** Reads bounded aggregates from one Context Mode 2.x `context.db` without writing to it. */
export function readContextModeDatabase(path: string): ContextModeDatabaseSnapshot {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    throw new ContextModeDatabaseError(
      "not-regular-database",
      path,
      "The database file could not be inspected.",
      error,
    );
  }
  if (!info.isFile()) {
    throw new ContextModeDatabaseError(
      "not-regular-database",
      path,
      ERROR_MESSAGES["not-regular-database"],
    );
  }
  if (info.size > MAX_DATABASE_BYTES) {
    throw new ContextModeDatabaseError(
      "database-open-failed",
      path,
      `The database exceeds the ${MAX_DATABASE_BYTES}-byte analytics limit.`,
    );
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      timeout: BUSY_TIMEOUT_MS,
    });
  } catch (error) {
    throw wrapError(error, path);
  }

  try {
    database.exec("PRAGMA query_only = ON");
    const versionRow = database.prepare("PRAGMA user_version").get() as DatabaseRow | undefined;
    const userVersion = nonNegativeInteger(versionRow?.user_version);
    if (userVersion !== SUPPORTED_CONTEXT_MODE_DATABASE_USER_VERSION) {
      throw new ContextModeDatabaseError(
        "unsupported-schema",
        path,
        `Unsupported Context Mode schema version ${userVersion}; expected ${SUPPORTED_CONTEXT_MODE_DATABASE_USER_VERSION}.`,
      );
    }
    assertRequiredSchema(database, path);
    database.exec("BEGIN DEFERRED");
    try {
      return readSnapshot(database);
    } finally {
      database.exec("ROLLBACK");
    }
  } catch (error) {
    throw wrapError(error, path);
  } finally {
    database.close();
  }
}
