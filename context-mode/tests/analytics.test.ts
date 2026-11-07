import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { collectContextModeAnalytics } from "../server/analytics";
import {
  discoverContextModeDatabases,
  resolveContextModeDataDir,
} from "../server/storage-discovery";
import {
  ContextModeAnalyticsDashboardSchema,
  getContextModeAnalyticsDashboard,
} from "../shared/analytics";

const temporaryDirectories: string[] = [];

/** Context Mode 2.1.4 `context.db` layout (PRAGMA user_version = 6). */
const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    worktree TEXT NOT NULL,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prompt','edit','cmd','toolerr','index','cost','decision')),
    tool TEXT,
    key TEXT,
    path TEXT,
    ok INTEGER,
    exit_code INTEGER,
    bytes INTEGER,
    body TEXT,
    turn INTEGER NOT NULL,
    sandbox_bytes INTEGER NOT NULL DEFAULT 0,
    returned_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL
  );
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    worktree TEXT NOT NULL,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('path','content','url')),
    label TEXT NOT NULL,
    bytes_total INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_ts INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    accessed_ts INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE chunks USING fts5(
    source_id UNINDEXED, session_id UNINDEXED, worktree UNINDEXED, agent UNINDEXED, ord UNINDEXED,
    body, title, tokenize = 'porter unicode61 remove_diacritics 2'
  );
`;

interface EventFixture {
  session: string;
  agent: string;
  kind: string;
  tool: string | null;
  sandbox: number;
  returned: number;
  at: string;
}

interface SourceFixture {
  session: string;
  agent: string;
  kind: "path" | "content" | "url";
  label: string;
  bytes: number;
  chunks: number;
  at: string;
}

interface DatabaseFixture {
  worktree: string;
  events: EventFixture[];
  sources?: SourceFixture[];
  wal?: boolean;
}

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-context-mode-analytics-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function openDatabase(
  dataDir: string,
  project: string,
  fixture: DatabaseFixture,
): Promise<DatabaseSync> {
  const directory = join(dataDir, "projects", project);
  await mkdir(join(directory, "owners"), { recursive: true });
  const database = new DatabaseSync(join(directory, "context.db"));
  database.exec(
    fixture.wal
      ? "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;"
      : "PRAGMA journal_mode = DELETE;",
  );
  database.exec(SCHEMA);
  database.exec("PRAGMA user_version = 6");
  const insertEvent = database.prepare(`INSERT INTO events (
    session_id, worktree, agent, kind, tool, ok, bytes, body, turn,
    sandbox_bytes, returned_bytes, created_at, accessed_at
  ) VALUES (?, ?, ?, ?, ?, 1, ?, 'output', 0, ?, ?, ?, ?)`);
  for (const event of fixture.events) {
    const at = Date.parse(event.at);
    insertEvent.run(
      event.session,
      fixture.worktree,
      event.agent,
      event.kind,
      event.tool,
      event.sandbox,
      event.sandbox,
      event.returned,
      at,
      at,
    );
  }
  const insertSource = database.prepare(`INSERT INTO sources (
    session_id, worktree, agent, kind, label, bytes_total, chunk_count, created_ts, created_at, accessed_ts
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const source of fixture.sources ?? []) {
    const at = Date.parse(source.at);
    insertSource.run(
      source.session,
      fixture.worktree,
      source.agent,
      source.kind,
      source.label,
      source.bytes,
      source.chunks,
      at,
      new Date(at).toISOString(),
      at,
    );
  }
  return database;
}

async function createDatabase(
  dataDir: string,
  project: string,
  fixture: DatabaseFixture,
): Promise<void> {
  (await openDatabase(dataDir, project, fixture)).close();
}

function singleCall(session: string, agent: string, sandbox: number, returned: number) {
  return {
    session,
    agent,
    kind: "cmd",
    tool: "ctx_execute",
    sandbox,
    returned,
    at: "2026-09-20T10:00:00.000Z",
  };
}

function collect(dataDir: string) {
  return collectContextModeAnalytics({
    env: { CONTEXT_MODE_DATA_DIR: dataDir },
    home: "/nonexistent-home",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Context Mode data dir", () => {
  test("uses an absolute CONTEXT_MODE_DATA_DIR and falls back to ~/.context-mode", () => {
    expect(resolveContextModeDataDir({ CONTEXT_MODE_DATA_DIR: "/srv/ctx/" }, "/home/u")).toBe(
      "/srv/ctx",
    );
    expect(resolveContextModeDataDir({ CONTEXT_MODE_DATA_DIR: "relative" }, "/home/u")).toBe(
      "/home/u/.context-mode",
    );
    expect(resolveContextModeDataDir({}, "/home/u")).toBe("/home/u/.context-mode");
  });
});

describe("structured Context Mode analytics", () => {
  test("matches ctx_stats savings math while reading live WAL data", async () => {
    const dataDir = await temporaryDataDir();
    const writer = await openDatabase(dataDir, "a1b2c3d4e5f60718", {
      worktree: "/work/alpha",
      wal: true,
      events: [
        {
          session: "mcp:s1",
          agent: "claude-code",
          kind: "cmd",
          tool: "ctx_execute",
          sandbox: 10_000,
          returned: 400,
          at: "2026-09-19T10:00:00.000Z",
        },
        {
          session: "mcp:s1",
          agent: "claude-code",
          kind: "index",
          tool: "ctx_index",
          sandbox: 2_000,
          returned: 100,
          at: "2026-09-19T10:05:00.000Z",
        },
        {
          session: "mcp:s1",
          agent: "claude-code",
          kind: "cmd",
          tool: "ctx_stats",
          sandbox: 0,
          returned: 3_000,
          at: "2026-09-19T10:06:00.000Z",
        },
        {
          session: "mcp:s1",
          agent: "claude-code",
          kind: "prompt",
          tool: null,
          sandbox: 0,
          returned: 0,
          at: "2026-09-19T10:07:00.000Z",
        },
        {
          session: "mcp:s2",
          agent: "codex",
          kind: "cmd",
          tool: "ctx_search",
          sandbox: 0,
          returned: 500,
          at: "2026-09-20T09:00:00.000Z",
        },
        {
          session: "mcp:s2",
          agent: "codex",
          kind: "cmd",
          tool: "ctx_batch",
          sandbox: 4_000,
          returned: 1_000,
          at: "2026-09-20T09:10:00.000Z",
        },
        {
          session: "mcp:s2",
          agent: "codex",
          kind: "cost",
          tool: null,
          sandbox: 0,
          returned: 0,
          at: "2026-09-20T09:20:00.000Z",
        },
        {
          session: "mcp:s3",
          agent: "codex",
          kind: "cmd",
          tool: "ctx_search",
          sandbox: 0,
          returned: 300,
          at: "2026-09-20T11:00:00.000Z",
        },
      ],
      sources: [
        {
          session: "mcp:s1",
          agent: "claude-code",
          kind: "path",
          label: "docs/guide.md",
          bytes: 2_048,
          chunks: 4,
          at: "2026-09-19T10:05:00.000Z",
        },
        {
          session: "mcp:s2",
          agent: "codex",
          kind: "content",
          label: "notes",
          bytes: 52,
          chunks: 1,
          at: "2026-09-20T09:00:00.000Z",
        },
      ],
    });

    try {
      const result = await collectContextModeAnalytics({
        env: { CONTEXT_MODE_DATA_DIR: dataDir },
        now: () => new Date("2026-09-21T12:00:00.000Z"),
      });
      expect(getContextModeAnalyticsDashboard.input.parse({})).toEqual({});
      expect(() => ContextModeAnalyticsDashboardSchema.parse(result)).not.toThrow();

      expect(result).toMatchObject({
        schemaVersion: 2,
        contextModeVersion: null,
        completeness: "complete",
        warnings: [],
        totals: {
          agents: 2,
          projects: 1,
          sessions: 3,
          events: 6,
          toolCalls: 5,
          indexedSources: 2,
          indexedChunks: 5,
          inputTokens: 4_000,
          outputTokens: 575,
          savedTokens: 3_500,
          savingsPercent: 87.5,
          byteAccounting: {
            producedBytes: 16_000,
            returnedBytes: 2_300,
            savedBytes: 14_000,
            indexedBytes: 2_100,
          },
          lastActivityAt: "2026-09-20T11:00:00.000Z",
        },
        generatedAt: "2026-09-21T12:00:00.000Z",
      });
      expect(result.byAgent).toEqual([
        {
          agent: "claude-code",
          projects: 1,
          sessions: 1,
          toolCalls: 2,
          indexedSources: 1,
          savedTokens: 2_875,
          savingsPercent: 95.8,
          byteAccounting: {
            producedBytes: 12_000,
            returnedBytes: 500,
            savedBytes: 11_500,
            indexedBytes: 2_048,
          },
        },
        {
          agent: "codex",
          projects: 1,
          sessions: 2,
          toolCalls: 3,
          indexedSources: 1,
          savedTokens: 625,
          savingsPercent: 62.5,
          byteAccounting: {
            producedBytes: 4_000,
            returnedBytes: 1_800,
            savedBytes: 2_500,
            indexedBytes: 52,
          },
        },
      ]);
      expect(result.byProject).toEqual([
        {
          path: "/work/alpha",
          worktrees: 1,
          sessions: 3,
          toolCalls: 5,
          indexedSources: 2,
          savedTokens: 3_500,
          savingsPercent: 87.5,
          byteAccounting: {
            producedBytes: 16_000,
            returnedBytes: 2_300,
            savedBytes: 14_000,
            indexedBytes: 2_100,
          },
          lastActivityAt: "2026-09-20T11:00:00.000Z",
        },
      ]);
      expect(result.byCategory).toEqual([
        { category: "ctx_execute", count: 1, savedTokens: 2_400 },
        { category: "ctx_batch", count: 1, savedTokens: 750 },
        { category: "ctx_index", count: 1, savedTokens: 475 },
        { category: "ctx_search", count: 2, savedTokens: 0 },
      ]);
      expect(result.byDay).toEqual([
        { date: "2026-09-19", calls: 2, savedTokens: 2_875 },
        { date: "2026-09-20", calls: 3, savedTokens: 750 },
      ]);
      expect(result.sources).toEqual([
        {
          agent: "codex",
          projectPath: "/work/alpha",
          source: "notes",
          kind: "content",
          chunks: 1,
          indexedBytes: 52,
          indexedAt: "2026-09-20T09:00:00.000Z",
          provider: "codex",
        },
        {
          agent: "claude-code",
          projectPath: "/work/alpha",
          source: "docs/guide.md",
          kind: "path",
          chunks: 4,
          indexedBytes: 2_048,
          indexedAt: "2026-09-19T10:05:00.000Z",
          provider: "claude",
        },
      ]);
    } finally {
      writer.close();
    }
  });

  test("aggregates every project database under the data dir", async () => {
    const dataDir = await temporaryDataDir();
    await createDatabase(dataDir, "1111111111111111", {
      worktree: "/work/a",
      events: [singleCall("mcp:a", "claude-code", 1_000, 200)],
    });
    await createDatabase(dataDir, "2222222222222222", {
      worktree: "/work/b",
      events: [
        singleCall("mcp:b", "claude-code", 4_000, 400),
        singleCall("mcp:c", "opencode", 800, 400),
      ],
    });
    await mkdir(join(dataDir, "projects", "3333333333333333", "owners"), { recursive: true });

    const result = await collect(dataDir);

    expect(result.completeness).toBe("complete");
    expect(result.totals).toMatchObject({
      agents: 2,
      projects: 2,
      sessions: 3,
      toolCalls: 3,
      byteAccounting: { savedBytes: 800 + 3_600 + 400 },
    });
    expect(result.byAgent).toEqual([
      expect.objectContaining({ agent: "claude-code", projects: 2, sessions: 2, toolCalls: 2 }),
      expect.objectContaining({ agent: "opencode", projects: 1, sessions: 1, toolCalls: 1 }),
    ]);
    expect(result.byProject.map((project) => project.path)).toEqual(["/work/b", "/work/a"]);
  });

  test("also reads the data dir a configured provider sets in its own env", async () => {
    const hostDir = await temporaryDataDir();
    const providerDir = await temporaryDataDir();
    await createDatabase(hostDir, "1111111111111111", {
      worktree: "/work/a",
      events: [singleCall("mcp:a", "claude-code", 1_000, 200)],
    });
    await createDatabase(providerDir, "2222222222222222", {
      worktree: "/work/b",
      events: [singleCall("mcp:b", "codex", 4_000, 400)],
    });

    const result = await collectContextModeAnalytics({
      env: { CONTEXT_MODE_DATA_DIR: hostDir },
      home: "/nonexistent-home",
      providers: {
        codex: { env: { CONTEXT_MODE_DATA_DIR: providerDir } },
        "codex-work": { extends: "codex" },
        claude: {},
      },
    });

    expect(result.completeness).toBe("complete");
    expect(result.byProject.map((project) => project.path)).toEqual(["/work/b", "/work/a"]);
  });

  test("routes each row's Resume and Forget to a provider that reaches its store", async () => {
    const hostDir = await temporaryDataDir();
    const workDir = await temporaryDataDir();
    await createDatabase(hostDir, "1111111111111111", {
      worktree: "/work/a",
      events: [singleCall("mcp:host", "codex", 1_000, 200), singleCall("mcp:x", "cursor", 10, 1)],
    });
    await createDatabase(workDir, "2222222222222222", {
      worktree: "/work/b",
      events: [singleCall("mcp:work", "codex", 4_000, 400)],
    });

    const result = await collectContextModeAnalytics({
      env: { CONTEXT_MODE_DATA_DIR: hostDir },
      home: "/nonexistent-home",
      // The codex provider itself moved to workDir, so host-dir codex rows need another way in.
      providers: { codex: { env: { CONTEXT_MODE_DATA_DIR: workDir } } },
    });

    const providerOf = (sessionId: string) =>
      result.recentSessions.find((session) => session.sessionId === sessionId)?.provider;
    expect(providerOf("mcp:work")).toBe("codex");
    expect(providerOf("mcp:host")).toBe("claude");
    expect(providerOf("mcp:x")).toBe("claude");
  });

  test("keeps the plugin's own calls out of sessions and totals, newest session first", async () => {
    const dataDir = await temporaryDataDir();
    await createDatabase(dataDir, "1111111111111111", {
      worktree: "/work/a",
      events: [
        { ...singleCall("mcp:old", "codex", 10, 1), at: "2026-09-19T10:00:00.000Z" },
        singleCall("paseo-context-mode", "codex", 10, 1),
      ],
    });
    await createDatabase(dataDir, "2222222222222222", {
      worktree: "/work/b",
      events: [
        singleCall("mcp:new", "claude-code", 10, 1),
        { ...singleCall("mcp:new", "claude-code", 10, 1), at: "2026-09-21T10:00:00.000Z" },
      ],
    });

    const result = await collect(dataDir);

    expect(result.totals).toMatchObject({ sessions: 2, events: 3, toolCalls: 3 });
    expect(result.byAgent.find(({ agent }) => agent === "codex")).toMatchObject({
      sessions: 1,
      toolCalls: 1,
    });
    expect(result.byCategory).toEqual([
      expect.objectContaining({ category: "ctx_execute", count: 3 }),
    ]);
    expect(result.recentSessions).toEqual([
      {
        sessionId: "mcp:new",
        agent: "claude-code",
        projectPath: "/work/b",
        events: 2,
        lastActivityAt: "2026-09-21T10:00:00.000Z",
        provider: "claude",
      },
      {
        sessionId: "mcp:old",
        agent: "codex",
        projectPath: "/work/a",
        events: 1,
        lastActivityAt: "2026-09-19T10:00:00.000Z",
        provider: "codex",
      },
    ]);
  });

  test("isolates a corrupt project database and preserves healthy results", async () => {
    const dataDir = await temporaryDataDir();
    await createDatabase(dataDir, "1111111111111111", {
      worktree: "/work/good",
      events: [singleCall("mcp:good", "codex", 100, 10)],
    });
    const broken = join(dataDir, "projects", "2222222222222222");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "context.db"), "not sqlite");

    const result = await collect(dataDir);

    expect(result.completeness).toBe("partial");
    expect(result.totals).toMatchObject({ projects: 1, sessions: 1, toolCalls: 1 });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "database-open-failed", project: "2222222222222222" }),
    );
  });

  test("rejects an unsupported user_version without reading it", async () => {
    const dataDir = await temporaryDataDir();
    const database = await openDatabase(dataDir, "1111111111111111", {
      worktree: "/work/old",
      events: [singleCall("mcp:old", "codex", 100, 10)],
    });
    database.exec("PRAGMA user_version = 5");
    database.close();

    const result = await collect(dataDir);

    expect(result.completeness).toBe("unsupported");
    expect(result.totals.events).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "unsupported-schema",
        project: "1111111111111111",
        message: expect.stringContaining("version 5"),
      }),
    );
  });

  test("reports a missing required column", async () => {
    const dataDir = await temporaryDataDir();
    const directory = join(dataDir, "projects", "1111111111111111");
    await mkdir(directory, { recursive: true });
    const database = new DatabaseSync(join(directory, "context.db"));
    database.exec(`
      CREATE TABLE events (session_id TEXT, worktree TEXT, agent TEXT, kind TEXT, tool TEXT,
        sandbox_bytes INTEGER, created_at INTEGER);
      CREATE TABLE sources (id INTEGER, worktree TEXT, agent TEXT, kind TEXT, label TEXT,
        bytes_total INTEGER, chunk_count INTEGER, created_ts INTEGER);
      PRAGMA user_version = 6;
    `);
    database.close();

    const result = await collect(dataDir);

    expect(result.completeness).toBe("unsupported");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "unsupported-schema",
        message: expect.stringContaining("returned_bytes"),
      }),
    );
  });

  test("reports a database locked by a writer as partial coverage", async () => {
    const dataDir = await temporaryDataDir();
    await createDatabase(dataDir, "1111111111111111", {
      worktree: "/work/free",
      events: [singleCall("mcp:free", "codex", 100, 10)],
    });
    const writer = await openDatabase(dataDir, "2222222222222222", {
      worktree: "/work/busy",
      events: [singleCall("mcp:busy", "codex", 100, 10)],
    });
    writer.exec("BEGIN EXCLUSIVE");

    try {
      const result = await collect(dataDir);

      expect(result.completeness).toBe("partial");
      expect(result.totals.projects).toBe(1);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "database-locked", project: "2222222222222222" }),
      );
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  test("keeps a lone locked database partial rather than unsupported", async () => {
    const dataDir = await temporaryDataDir();
    const writer = await openDatabase(dataDir, "2222222222222222", {
      worktree: "/work/busy",
      events: [singleCall("mcp:busy", "codex", 100, 10)],
    });
    writer.exec("BEGIN EXCLUSIVE");

    try {
      const result = await collect(dataDir);

      expect(result.completeness).toBe("partial");
      expect(result.totals.projects).toBe(0);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  test("leaves database bytes and directory contents unchanged", async () => {
    const dataDir = await temporaryDataDir();
    await createDatabase(dataDir, "1111111111111111", {
      worktree: "/work/project",
      events: [singleCall("mcp:s", "codex", 100, 10)],
    });
    const directory = join(dataDir, "projects", "1111111111111111");
    const path = join(directory, "context.db");
    const beforeBytes = await readFile(path);
    const beforeStat = await stat(path);
    const beforeEntries = await readdir(directory);

    const result = await collect(dataDir);

    expect(result.totals.events).toBe(1);
    expect((await readFile(path)).equals(beforeBytes)).toBe(true);
    expect((await stat(path)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readdir(directory)).toEqual(beforeEntries);
  });
});

describe("Context Mode database discovery", () => {
  test("returns nothing for a missing data dir", async () => {
    const dataDir = await temporaryDataDir();
    await expect(discoverContextModeDatabases(join(dataDir, "missing"))).resolves.toEqual({
      databases: [],
      warnings: [],
    });
  });

  test("skips project dirs without a database and flags non-regular entries", async () => {
    const dataDir = await temporaryDataDir();
    await mkdir(join(dataDir, "projects", "empty"), { recursive: true });
    await mkdir(join(dataDir, "projects", "nested", "context.db"), { recursive: true });
    await mkdir(join(dataDir, "projects", "real"), { recursive: true });
    await writeFile(join(dataDir, "projects", "real", "context.db"), "");

    const result = await discoverContextModeDatabases(dataDir);

    expect(result.databases).toEqual([
      { project: "real", path: join(dataDir, "projects", "real", "context.db") },
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "not-regular-database", project: "nested" }),
    ]);
  });

  test("caps the number of inspected projects and warns", async () => {
    const dataDir = await temporaryDataDir();
    await createDatabase(dataDir, "000", {
      worktree: "/work/first",
      events: [singleCall("mcp:first", "codex", 100, 10)],
    });
    for (let index = 1; index <= 256; index += 1) {
      await mkdir(join(dataDir, "projects", String(index).padStart(3, "0")), { recursive: true });
    }
    await createDatabase(dataDir, "zzz", {
      worktree: "/work/last",
      events: [singleCall("mcp:last", "codex", 100, 10)],
    });

    const discovery = await discoverContextModeDatabases(dataDir);
    expect(discovery.databases.map((database) => database.project)).toEqual(["000"]);
    expect(discovery.warnings).toContainEqual(
      expect.objectContaining({
        code: "result-truncated",
        message: expect.stringContaining("Only the first 256 of 258"),
      }),
    );

    const result = await collect(dataDir);
    expect(result.completeness).toBe("partial");
    expect(result.totals.projects).toBe(1);
  });
});
