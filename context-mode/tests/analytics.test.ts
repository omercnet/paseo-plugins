import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { collectContextModeAnalytics } from "../server/analytics";
import { discoverContextModeStorageRoots } from "../server/storage-discovery";
import {
  ContextModeAnalyticsDashboardSchema,
  getContextModeAnalyticsDashboard,
} from "../shared/analytics";

const temporaryDirectories: string[] = [];

interface EventFixture {
  sessionId: string;
  category: string;
  data: string;
  project: string;
  avoided: number;
  returned: number;
  createdAt: string;
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "paseo-context-mode-analytics-"));
  temporaryDirectories.push(home);
  return home;
}

async function openSessionDatabase(
  home: string,
  providerDirectory: string,
  filename: string,
  events: EventFixture[],
  wal = false,
): Promise<DatabaseSync> {
  const directory = join(home, providerDirectory, "context-mode", "sessions");
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, filename));
  if (wal) {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  }
  database.exec(`
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2,
      data TEXT NOT NULL,
      project_dir TEXT NOT NULL DEFAULT '',
      attribution_source TEXT NOT NULL DEFAULT 'unknown',
      attribution_confidence REAL NOT NULL DEFAULT 0,
      bytes_avoided INTEGER NOT NULL DEFAULT 0,
      bytes_returned INTEGER NOT NULL DEFAULT 0,
      source_hook TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      compact_count INTEGER NOT NULL DEFAULT 0,
      usage_cursor TEXT
    );
    CREATE TABLE session_resume (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      snapshot TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tool_calls (
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      bytes_returned INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, tool)
    );
  `);
  const insertEvent = database.prepare(`INSERT INTO session_events (
    session_id, type, category, data, project_dir, bytes_avoided, bytes_returned,
    source_hook, created_at
  ) VALUES (?, 'tool', ?, ?, ?, ?, ?, 'PostToolUse', ?)`);
  const insertMeta = database.prepare(`INSERT OR IGNORE INTO session_meta (
    session_id, project_dir, started_at, event_count
  ) VALUES (?, ?, ?, 1)`);
  for (const event of events) {
    insertEvent.run(
      event.sessionId,
      event.category,
      event.data,
      event.project,
      event.avoided,
      event.returned,
      event.createdAt,
    );
    insertMeta.run(event.sessionId, event.project, event.createdAt);
  }
  return database;
}

async function createContentDatabase(home: string): Promise<void> {
  const directory = join(home, ".claude", "context-mode", "content");
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "project.db"));
  try {
    database.exec(`
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL,
        file_path TEXT,
        content_hash TEXT
      );
      CREATE VIRTUAL TABLE chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
    database
      .prepare(
        "INSERT INTO sources (id, label, chunk_count, code_chunk_count, indexed_at) VALUES (1, ?, 2, 1, ?)",
      )
      .run("Context docs", "2026-09-20 09:00:00");
    const insertChunk = database.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, 1, ?)",
    );
    insertChunk.run("A", "hello", "prose");
    insertChunk.run("B", "é", "code");
  } finally {
    database.close();
  }
}

async function createMinimalSessionDatabase(
  home: string,
  providerDirectory: string,
  sessionId: string,
  project: string,
): Promise<void> {
  const database = await openSessionDatabase(home, providerDirectory, "project.db", [
    {
      sessionId,
      category: "file",
      data: "data",
      project,
      avoided: 12,
      returned: 4,
      createdAt: "2026-09-20 10:00:00",
    },
  ]);
  database.close();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("structured Context Mode analytics", () => {
  test("aggregates the 1.0.169 session and content schemas while reading live WAL data", async () => {
    const home = await temporaryHome();
    const sessionDatabase = await openSessionDatabase(
      home,
      ".claude",
      "project.db",
      [
        {
          sessionId: "session-1",
          category: "file",
          data: "abcd",
          project: "/work/project",
          avoided: 12,
          returned: 4,
          createdAt: "2026-09-19 10:00:00",
        },
        {
          sessionId: "session-1",
          category: "rule",
          data: "é",
          project: "/work/project",
          avoided: 6,
          returned: 0,
          createdAt: "2026-09-19 11:00:00",
        },
      ],
      true,
    );
    sessionDatabase
      .prepare(
        "INSERT INTO session_resume (session_id, snapshot, event_count, created_at, consumed) VALUES (?, ?, 2, ?, 1)",
      )
      .run("session-1", "12345678", "2026-09-20 08:00:00");
    const insertTool = sessionDatabase.prepare(
      "INSERT INTO tool_calls (session_id, tool, calls, bytes_returned, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    insertTool.run("session-1", "ctx_search", 2, 8, "2026-09-20 08:30:00");
    insertTool.run("session-1", "ctx_execute", 3, 100, "2026-09-20 08:45:00");
    await createContentDatabase(home);

    try {
      const result = await collectContextModeAnalytics({
        home,
        env: {},
        now: () => new Date("2026-09-20T12:00:00.000Z"),
      });
      expect(getContextModeAnalyticsDashboard.input.parse({})).toEqual({});
      expect(() => ContextModeAnalyticsDashboardSchema.parse(result)).not.toThrow();

      expect(result).toMatchObject({
        schemaVersion: 1,
        contextModeVersion: "1.0.169",
        completeness: "complete",
        warnings: [],
        totals: {
          providers: 1,
          databases: 2,
          projects: 1,
          sessions: 1,
          events: 2,
          toolCalls: 5,
          indexedSources: 1,
          indexedChunks: 2,
          inputTokens: 13,
          outputTokens: 3,
          savedTokens: 10,
          savingsPercent: 77.4,
          byteAccounting: {
            eventDataBytes: 6,
            avoidedBytes: 18,
            returnedBytes: 12,
            snapshotBytes: 8,
            indexedBytes: 9,
            savedBytes: 41,
          },
        },
        generatedAt: "2026-09-20T12:00:00.000Z",
      });
      expect(result.byCategory).toEqual([
        { category: "file", count: 1, savedTokens: 4 },
        { category: "rule", count: 1, savedTokens: 2 },
      ]);
      expect(result.byDay).toEqual([
        { date: "2026-09-19", calls: 2, savedTokens: 6 },
        { date: "2026-09-20", calls: 0, savedTokens: 4 },
      ]);
      expect(result.sources).toEqual([
        {
          provider: "claude-code",
          source: "Context docs",
          chunks: 2,
          codeChunks: 1,
          indexedBytes: 9,
          indexedAt: "2026-09-20T09:00:00.000Z",
          state: "ready",
        },
      ]);
    } finally {
      sessionDatabase.close();
    }
  });

  test("reports a missing active-schema column without attempting a migration", async () => {
    const home = await temporaryHome();
    const directory = join(home, ".claude", "context-mode", "sessions");
    await mkdir(directory, { recursive: true });
    const database = new DatabaseSync(join(directory, "old.db"));
    database.exec(`
      CREATE TABLE session_events (
        session_id TEXT, category TEXT, data TEXT, project_dir TEXT,
        bytes_avoided INTEGER, created_at TEXT
      );
      CREATE TABLE session_meta (session_id TEXT, project_dir TEXT);
      CREATE TABLE session_resume (session_id TEXT, snapshot TEXT, created_at TEXT);
      CREATE TABLE tool_calls (session_id TEXT, tool TEXT, calls INTEGER, bytes_returned INTEGER);
    `);
    database.close();

    const result = await collectContextModeAnalytics({ home, env: {} });

    expect(result.completeness).toBe("unsupported");
    expect(result.totals.databases).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "unsupported-schema",
        provider: "claude-code",
        database: "old.db",
        message: expect.stringContaining("bytes_returned"),
      }),
    );
  });

  test("rejects a database that declares an unknown schema version", async () => {
    const home = await temporaryHome();
    const database = await openSessionDatabase(home, ".claude", "future.db", [
      {
        sessionId: "future-session",
        category: "file",
        data: "future",
        project: "/work/future",
        avoided: 12,
        returned: 4,
        createdAt: "2026-09-20 10:00:00",
      },
    ]);
    database.exec("PRAGMA user_version = 2");
    database.close();

    const result = await collectContextModeAnalytics({ home, env: {} });

    expect(result.completeness).toBe("unsupported");
    expect(result.totals.events).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "unsupported-schema",
        database: "future.db",
        message: expect.stringContaining("version 2"),
      }),
    );
  });

  test("isolates a corrupt provider database and preserves healthy results", async () => {
    const home = await temporaryHome();
    await createMinimalSessionDatabase(home, ".claude", "good", "/work/good");
    const corruptDirectory = join(home, ".codex", "context-mode", "sessions");
    await mkdir(corruptDirectory, { recursive: true });
    await writeFile(join(corruptDirectory, "broken.db"), "not sqlite");

    const result = await collectContextModeAnalytics({ home, env: {} });

    expect(result.completeness).toBe("partial");
    expect(result.totals).toMatchObject({ providers: 2, databases: 1, sessions: 1, events: 1 });
    expect(result.byProvider).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "claude-code", databases: 1, events: 1 }),
        expect.objectContaining({ provider: "codex", databases: 0, events: 0 }),
      ]),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ provider: "codex", database: "broken.db" }),
    );
  });

  test("accumulates distinct sessions and projects across providers", async () => {
    const home = await temporaryHome();
    await createMinimalSessionDatabase(home, ".claude", "claude-session", "/work/a");
    await createMinimalSessionDatabase(home, ".codex", "codex-session", "/work/b");

    const result = await collectContextModeAnalytics({ home, env: {} });

    expect(result.completeness).toBe("complete");
    expect(result.totals).toMatchObject({
      providers: 2,
      databases: 2,
      projects: 2,
      sessions: 2,
      events: 2,
      savedTokens: 8,
    });
    expect(result.byProvider).toEqual([
      expect.objectContaining({ provider: "claude-code", sessions: 1, savedTokens: 4 }),
      expect.objectContaining({ provider: "codex", sessions: 1, savedTokens: 4 }),
    ]);
  });

  test("leaves database bytes and directory contents unchanged", async () => {
    const home = await temporaryHome();
    await createMinimalSessionDatabase(home, ".claude", "session", "/work/project");
    const directory = join(home, ".claude", "context-mode", "sessions");
    const path = join(directory, "project.db");
    const beforeBytes = await readFile(path);
    const beforeStat = await stat(path);
    const beforeEntries = await readdir(directory);

    const result = await collectContextModeAnalytics({ home, env: {} });

    const afterBytes = await readFile(path);
    const afterStat = await stat(path);
    const afterEntries = await readdir(directory);
    expect(result.totals.events).toBe(1);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterEntries).toEqual(beforeEntries);
  });

  test("discovers data-root overrides and Windows OpenCode locations", async () => {
    const home = await temporaryHome();
    const dataRoot = join(home, "shared-data");
    const appData = join(home, "AppData", "Roaming");
    await mkdir(join(dataRoot, "context-mode"), { recursive: true });
    await mkdir(join(appData, "opencode", "context-mode"), { recursive: true });
    await mkdir(join(home, ".config", "zed", "context-mode"), { recursive: true });

    const result = await discoverContextModeStorageRoots({
      home,
      platform: "win32",
      env: { CONTEXT_MODE_DATA_DIR: dataRoot, APPDATA: appData, XDG_CONFIG_HOME: "/wrong" },
    });

    expect(result.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "custom-data",
          root: join(dataRoot, "context-mode"),
        }),
        expect.objectContaining({
          provider: "opencode",
          root: join(appData, "opencode", "context-mode"),
        }),
        expect.objectContaining({
          provider: "zed",
          root: join(home, ".config", "zed", "context-mode"),
        }),
      ]),
    );
  });
});
