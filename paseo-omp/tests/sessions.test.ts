import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listOmpSessionsFrom } from "../server/sessions";

const temporaryDirectories: string[] = [];

function createHistoryDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE history (
    id INTEGER PRIMARY KEY,
    prompt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    cwd TEXT,
    session_id TEXT
  )`);
  database.exec(`CREATE TABLE session_titles (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return database;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("omp sessions reader", () => {
  test("filters by cwd, newest first, and attaches session titles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-omp-sessions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "history.db");
    const database = createHistoryDatabase(path);
    database
      .prepare(
        "INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, "first prompt", 1_000, "/work/a", "sess-1");
    database
      .prepare(
        "INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(2, "second prompt", 2_000, "/work/a", "sess-1");
    database
      .prepare(
        "INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(3, "other cwd prompt", 3_000, "/work/b", null);
    database
      .prepare("INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)")
      .run("sess-1", "Fix auth bug", 2_000);
    database.close();

    const sessions = listOmpSessionsFrom(path, "/work/a");

    expect(sessions).toEqual([
      {
        id: 2,
        sessionId: "sess-1",
        title: "Fix auth bug",
        prompt: "second prompt",
        truncated: false,
        createdAt: 2_000,
      },
      {
        id: 1,
        sessionId: "sess-1",
        title: "Fix auth bug",
        prompt: "first prompt",
        truncated: false,
        createdAt: 1_000,
      },
    ]);
  });

  test("truncates long prompts and marks them truncated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-omp-sessions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "history.db");
    const database = createHistoryDatabase(path);
    const longPrompt = "x".repeat(500);
    database
      .prepare(
        "INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, longPrompt, 1_000, "/work/a", null);
    database.close();

    const [entry] = listOmpSessionsFrom(path, "/work/a");

    expect(entry?.truncated).toBe(true);
    expect(entry?.prompt.length).toBe(400);
    expect(entry?.title).toBeNull();
  });

  test("returns an empty list when the database is missing", () => {
    expect(listOmpSessionsFrom("/nonexistent/history.db", "/work/a")).toEqual([]);
  });
});
