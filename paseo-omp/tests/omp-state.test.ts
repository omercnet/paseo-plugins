import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { listOmpMemoryFrom } from "../server/memory";
import { listOmpQuotasFrom } from "../server/quota";

const temporaryDirectories: string[] = [];

function createUsageDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE usage_history (
    id INTEGER PRIMARY KEY,
    recorded_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    account_key TEXT NOT NULL,
    limit_id TEXT NOT NULL,
    label TEXT NOT NULL,
    window_label TEXT,
    used_fraction REAL,
    status TEXT,
    resets_at INTEGER
  )`);
  return database;
}

function createMemoryDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE facts (
    fact_id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    confidence REAL,
    timestamp TEXT,
    created_at TEXT
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

describe("omp quota reader", () => {
  test("keeps only the newest record for each provider account limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-"));
    temporaryDirectories.push(root);
    const database = createUsageDatabase(join(root, "agent.db"));
    database.exec(`INSERT INTO usage_history VALUES
      (1, 100, 'anthropic', 'account', 'five-hour', 'Claude 5 Hour', '5 Hour', 0.1, 'ok', 300),
      (2, 200, 'anthropic', 'account', 'five-hour', 'Claude 5 Hour', '5 Hour', 0.8, 'ok', 400),
      (3, 150, 'openai', 'account', 'weekly', 'Codex Weekly', 'Weekly', 0.3, 'ok', NULL)`);
    database.close();

    expect(listOmpQuotasFrom(join(root, "agent.db"))).toEqual([
      {
        provider: "anthropic",
        label: "Claude 5 Hour",
        windowLabel: "5 Hour",
        usedFraction: 0.8,
        status: "ok",
        resetsAt: 400,
        recordedAt: 200,
      },
      {
        provider: "openai",
        label: "Codex Weekly",
        windowLabel: "Weekly",
        usedFraction: 0.3,
        status: "ok",
        resetsAt: null,
        recordedAt: 150,
      },
    ]);
  });
});

describe("omp memory reader", () => {
  test("chooses the newest bank matching the workspace basename", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-"));
    temporaryDirectories.push(root);
    const oldBank = join(root, "gray-bird-old");
    const newestBank = join(root, "gray-bird-new");
    await mkdir(oldBank);
    await mkdir(newestBank);
    const old = createMemoryDatabase(join(oldBank, "mnemopi.db"));
    old.exec("INSERT INTO facts VALUES ('old', 'old', 'is', 'ignored', 1, NULL, NULL)");
    old.close();
    const current = createMemoryDatabase(join(newestBank, "mnemopi.db"));
    await utimes(oldBank, new Date(1_000), new Date(1_000));
    current.exec(
      "INSERT INTO facts VALUES ('current', 'paseo-omp', 'integrates', 'omp', 0.9, '2026-09-10', NULL)",
    );
    current.close();

    const memory = await listOmpMemoryFrom(root, "/workspaces/gray-bird");

    expect(memory).toEqual({
      bank: "gray-bird-new",
      facts: [
        {
          id: "current",
          subject: "paseo-omp",
          predicate: "integrates",
          object: "omp",
          confidence: 0.9,
          timestamp: "2026-09-10",
        },
      ],
    });
  });
});
