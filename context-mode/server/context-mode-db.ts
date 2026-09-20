import { lstatSync, type Stats } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BUSY_TIMEOUT_MS = 150;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_DISTINCT_IDENTITIES = 5_000;
const MAX_GROUP_ROWS = 4_096;
const MAX_SOURCE_ROWS = 2_000;

const REQUIRED_SESSION_SCHEMA: Record<string, readonly string[]> = {
  session_events: [
    "session_id",
    "category",
    "data",
    "project_dir",
    "bytes_avoided",
    "bytes_returned",
    "created_at",
  ],
  session_meta: ["session_id", "project_dir"],
  session_resume: ["session_id", "snapshot", "created_at"],
  tool_calls: ["session_id", "tool", "calls", "bytes_returned"],
};

const REQUIRED_CONTENT_SCHEMA: Record<string, readonly string[]> = {
  sources: ["id", "label", "chunk_count", "code_chunk_count", "indexed_at"],
  chunks: ["title", "content", "source_id", "content_type"],
};

type DatabaseRow = Record<string, unknown>;

export type ContextModeDatabaseErrorCode =
  | "not-regular-database"
  | "database-open-failed"
  | "unsupported-schema"
  | "database-query-failed";

export class ContextModeDatabaseError extends Error {
  readonly code: ContextModeDatabaseErrorCode;
  readonly database: string;

  constructor(code: ContextModeDatabaseErrorCode, path: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ContextModeDatabaseError";
    this.code = code;
    this.database = basename(path);
  }
}

export interface DatabaseCategorySummary {
  category: string;
  count: number;
  savedBytes: number;
}

export interface DatabaseDaySummary {
  date: string;
  calls: number;
  savedBytes: number;
}

export interface SessionDatabaseSnapshot {
  kind: "session";
  sessions: string[];
  projects: string[];
  events: number;
  toolCalls: number;
  eventDataBytes: number;
  avoidedBytes: number;
  returnedBytes: number;
  snapshotBytes: number;
  byCategory: DatabaseCategorySummary[];
  byDay: DatabaseDaySummary[];
}

export interface ContentSourceSnapshot {
  source: string;
  chunks: number;
  codeChunks: number;
  indexedBytes: number;
  indexedAt: string | null;
  detail?: string;
}

export interface ContentDatabaseSnapshot {
  kind: "content";
  indexedBytes: number;
  chunks: number;
  codeChunks: number;
  sources: ContentSourceSnapshot[];
  byDay: DatabaseDaySummary[];
  inconsistencies: string[];
}

export type ContextModeDatabaseSnapshot = SessionDatabaseSnapshot | ContentDatabaseSnapshot;

function nonNegativeInteger(value: unknown): number {
  const numeric = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric));
}

function boundedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function boundedText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum);
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const input = value.trim().replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input) ? input : `${input}Z`;
  const milliseconds = Date.parse(zoned);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function columnsFor(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_xinfo('${table}')`).all() as DatabaseRow[];
  return new Set(
    rows.flatMap((row) => (typeof row.name === "string" && row.name ? [row.name] : [])),
  );
}

function assertRequiredSchema(
  database: DatabaseSync,
  path: string,
  expected: Record<string, readonly string[]>,
): void {
  for (const [table, requiredColumns] of Object.entries(expected)) {
    const columns = columnsFor(database, table);
    if (columns.size === 0) {
      throw new ContextModeDatabaseError(
        "unsupported-schema",
        path,
        `Unsupported Context Mode schema: missing ${table}.`,
      );
    }
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new ContextModeDatabaseError(
        "unsupported-schema",
        path,
        `Unsupported Context Mode schema: ${table} is missing ${missing.join(", ")}.`,
      );
    }
  }
}

function incrementSummary(
  summaries: Map<string, { count: number; savedBytes: number }>,
  key: string,
  count: number,
  savedBytes: number,
): void {
  const current = summaries.get(key) ?? { count: 0, savedBytes: 0 };
  current.count = boundedAdd(current.count, count);
  current.savedBytes = boundedAdd(current.savedBytes, savedBytes);
  summaries.set(key, current);
}

function readSessionDatabase(database: DatabaseSync, path: string): SessionDatabaseSnapshot {
  assertRequiredSchema(database, path, REQUIRED_SESSION_SCHEMA);
  const sessions = new Set<string>();
  const projects = new Set<string>();

  for (const row of database
    .prepare("SELECT DISTINCT session_id, project_dir FROM session_events LIMIT ?")
    .all(MAX_DISTINCT_IDENTITIES) as DatabaseRow[]) {
    const session = boundedText(row.session_id, "", 4_096);
    const project = boundedText(row.project_dir, "", 4_096);
    if (session) sessions.add(session);
    if (project) projects.add(project);
  }
  for (const row of database
    .prepare("SELECT session_id, project_dir FROM session_meta LIMIT ?")
    .all(MAX_DISTINCT_IDENTITIES) as DatabaseRow[]) {
    const session = boundedText(row.session_id, "", 4_096);
    const project = boundedText(row.project_dir, "", 4_096);
    if (session) sessions.add(session);
    if (project) projects.add(project);
  }

  const totals = database
    .prepare(`SELECT
      COUNT(*) AS events,
      COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS data_bytes,
      COALESCE(SUM(bytes_avoided), 0) AS avoided_bytes,
      COALESCE(SUM(bytes_returned), 0) AS returned_bytes
    FROM session_events`)
    .get() as DatabaseRow;
  const resumeTotals = database
    .prepare(
      "SELECT COALESCE(SUM(length(CAST(snapshot AS BLOB))), 0) AS snapshot_bytes FROM session_resume",
    )
    .get() as DatabaseRow;
  const toolTotals = database
    .prepare("SELECT COALESCE(SUM(calls), 0) AS calls FROM tool_calls")
    .get() as DatabaseRow;
  const searchReturns = database
    .prepare(
      "SELECT COALESCE(SUM(bytes_returned), 0) AS bytes_returned FROM tool_calls WHERE tool IN ('ctx_search', 'ctx_fetch_and_index')",
    )
    .get() as DatabaseRow;

  const byCategory = (
    database
      .prepare(`SELECT
        category,
        COUNT(*) AS count,
        COALESCE(SUM(length(CAST(data AS BLOB)) + bytes_avoided), 0) AS saved_bytes
      FROM session_events
      GROUP BY category
      ORDER BY count DESC
      LIMIT ?`)
      .all(MAX_GROUP_ROWS) as DatabaseRow[]
  ).map((row) => ({
    category: boundedText(row.category, "unknown", 256),
    count: nonNegativeInteger(row.count),
    savedBytes: nonNegativeInteger(row.saved_bytes),
  }));

  const daySummaries = new Map<string, { count: number; savedBytes: number }>();
  for (const row of database
    .prepare(`SELECT
      date(created_at) AS day,
      COUNT(*) AS calls,
      COALESCE(SUM(length(CAST(data AS BLOB)) + bytes_avoided), 0) AS saved_bytes
    FROM session_events
    WHERE created_at IS NOT NULL
    GROUP BY date(created_at)
    ORDER BY day DESC
    LIMIT ?`)
    .all(MAX_GROUP_ROWS) as DatabaseRow[]) {
    const day = boundedText(row.day, "", 10);
    if (day)
      incrementSummary(
        daySummaries,
        day,
        nonNegativeInteger(row.calls),
        nonNegativeInteger(row.saved_bytes),
      );
  }
  for (const row of database
    .prepare(`SELECT
      date(created_at) AS day,
      COALESCE(SUM(length(CAST(snapshot AS BLOB))), 0) AS saved_bytes
    FROM session_resume
    WHERE created_at IS NOT NULL
    GROUP BY date(created_at)
    ORDER BY day DESC
    LIMIT ?`)
    .all(MAX_GROUP_ROWS) as DatabaseRow[]) {
    const day = boundedText(row.day, "", 10);
    if (day) incrementSummary(daySummaries, day, 0, nonNegativeInteger(row.saved_bytes));
  }

  return {
    kind: "session",
    sessions: [...sessions],
    projects: [...projects],
    events: nonNegativeInteger(totals.events),
    toolCalls: nonNegativeInteger(toolTotals.calls),
    eventDataBytes: nonNegativeInteger(totals.data_bytes),
    avoidedBytes: nonNegativeInteger(totals.avoided_bytes),
    returnedBytes: boundedAdd(
      nonNegativeInteger(totals.returned_bytes),
      nonNegativeInteger(searchReturns.bytes_returned),
    ),
    snapshotBytes: nonNegativeInteger(resumeTotals.snapshot_bytes),
    byCategory,
    byDay: [...daySummaries].map(([date, summary]) => ({
      date,
      calls: summary.count,
      savedBytes: summary.savedBytes,
    })),
  };
}

function readContentDatabase(database: DatabaseSync, path: string): ContentDatabaseSnapshot {
  assertRequiredSchema(database, path, REQUIRED_CONTENT_SCHEMA);
  const totals = database
    .prepare(`SELECT
      COUNT(*) AS chunks,
      COALESCE(SUM(CASE WHEN content_type = 'code' THEN 1 ELSE 0 END), 0) AS code_chunks,
      COALESCE(SUM(length(CAST(title AS BLOB)) + length(CAST(content AS BLOB))), 0) AS indexed_bytes
    FROM chunks`)
    .get() as DatabaseRow;
  const chunksBySource = new Map<
    string,
    { chunks: number; codeChunks: number; indexedBytes: number }
  >();
  for (const row of database
    .prepare(`SELECT
      source_id,
      COUNT(*) AS chunks,
      COALESCE(SUM(CASE WHEN content_type = 'code' THEN 1 ELSE 0 END), 0) AS code_chunks,
      COALESCE(SUM(length(CAST(title AS BLOB)) + length(CAST(content AS BLOB))), 0) AS indexed_bytes
    FROM chunks
    GROUP BY source_id
    LIMIT ?`)
    .all(MAX_SOURCE_ROWS + 1) as DatabaseRow[]) {
    const sourceId = String(row.source_id ?? "");
    chunksBySource.set(sourceId, {
      chunks: nonNegativeInteger(row.chunks),
      codeChunks: nonNegativeInteger(row.code_chunks),
      indexedBytes: nonNegativeInteger(row.indexed_bytes),
    });
  }

  const sources: ContentSourceSnapshot[] = [];
  const inconsistencies: string[] = [];
  const days = new Map<string, { count: number; savedBytes: number }>();
  const sourceRows = database
    .prepare(
      "SELECT id, label, chunk_count, code_chunk_count, indexed_at FROM sources ORDER BY id LIMIT ?",
    )
    .all(MAX_SOURCE_ROWS + 1) as DatabaseRow[];
  if (sourceRows.length > MAX_SOURCE_ROWS || chunksBySource.size > MAX_SOURCE_ROWS) {
    inconsistencies.push(`Source analytics were limited to ${MAX_SOURCE_ROWS} rows.`);
  }
  for (const row of sourceRows.slice(0, MAX_SOURCE_ROWS)) {
    const sourceId = String(row.id ?? "");
    const actual = chunksBySource.get(sourceId) ?? {
      chunks: 0,
      codeChunks: 0,
      indexedBytes: 0,
    };
    chunksBySource.delete(sourceId);
    const storedChunks = nonNegativeInteger(row.chunk_count);
    const storedCodeChunks = nonNegativeInteger(row.code_chunk_count);
    const source = boundedText(row.label, "(unnamed source)", 4_096);
    const indexedAt = normalizedTimestamp(row.indexed_at);
    let detail: string | undefined;
    if (storedChunks !== actual.chunks || storedCodeChunks !== actual.codeChunks) {
      detail = `Stored counts ${storedChunks}/${storedCodeChunks} differ from readable chunks ${actual.chunks}/${actual.codeChunks}.`;
      if (inconsistencies.length < 10) inconsistencies.push(`${source}: ${detail}`);
    }
    sources.push({
      source,
      chunks: actual.chunks,
      codeChunks: actual.codeChunks,
      indexedBytes: actual.indexedBytes,
      indexedAt,
      ...(detail ? { detail } : {}),
    });
    const day = indexedAt?.slice(0, 10);
    if (day) incrementSummary(days, day, 0, actual.indexedBytes);
  }

  if (chunksBySource.size > 0 && inconsistencies.length < 10) {
    const orphanChunks = [...chunksBySource.values()].reduce(
      (total, value) => boundedAdd(total, value.chunks),
      0,
    );
    inconsistencies.push(`${orphanChunks} chunks reference a missing or unscanned source row.`);
  }

  return {
    kind: "content",
    indexedBytes: nonNegativeInteger(totals.indexed_bytes),
    chunks: nonNegativeInteger(totals.chunks),
    codeChunks: nonNegativeInteger(totals.code_chunks),
    sources,
    byDay: [...days].map(([date, summary]) => ({
      date,
      calls: summary.count,
      savedBytes: summary.savedBytes,
    })),
    inconsistencies,
  };
}

function classifyDatabaseError(error: unknown): ContextModeDatabaseErrorCode {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes("not a database") ||
    message.includes("database disk image is malformed") ||
    message.includes("database is locked") ||
    message.includes("database is busy") ||
    message.includes("unable to open database")
  ) {
    return "database-open-failed";
  }
  return "database-query-failed";
}

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
  if (!path.endsWith(".db") || !info.isFile()) {
    throw new ContextModeDatabaseError(
      "not-regular-database",
      path,
      "Only regular .db files can be inspected.",
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
    throw new ContextModeDatabaseError(
      "database-open-failed",
      path,
      "The database could not be opened read-only.",
      error,
    );
  }

  try {
    database.exec("PRAGMA query_only = ON");
    const versionRow = database.prepare("PRAGMA user_version").get() as DatabaseRow | undefined;
    const userVersion = nonNegativeInteger(versionRow?.user_version);
    if (userVersion !== 0) {
      throw new ContextModeDatabaseError(
        "unsupported-schema",
        path,
        `Unsupported Context Mode schema version ${userVersion}; expected the 1.0.169 layout.`,
      );
    }
    const tableRows = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all() as DatabaseRow[];
    const tables = new Set(
      tableRows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    const hasSessionSchema = tables.has("session_events");
    const hasContentSchema = tables.has("sources") || tables.has("chunks");
    if (hasSessionSchema && hasContentSchema) {
      throw new ContextModeDatabaseError(
        "unsupported-schema",
        path,
        "Unsupported Context Mode schema: session and content tables are mixed.",
      );
    }
    if (hasSessionSchema) return readSessionDatabase(database, path);
    if (hasContentSchema) return readContentDatabase(database, path);
    throw new ContextModeDatabaseError(
      "unsupported-schema",
      path,
      "Unsupported Context Mode schema: no recognized Context Mode tables.",
    );
  } catch (error) {
    if (error instanceof ContextModeDatabaseError) throw error;
    throw new ContextModeDatabaseError(
      classifyDatabaseError(error),
      path,
      "The database could not be queried safely.",
      error,
    );
  } finally {
    database.close();
  }
}
