import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A unit row as omp 19's per-user daemon persists it (`daemon/store.ts`, schema version 1). */
export interface DaemonUnitFixture {
  id: string;
  key: string;
  kind?: string;
  /** Defaults to the project scope of `/workspace/project`. */
  scopeKey?: string;
  /** Replaces the JSON snapshot verbatim, for malformed-record cases. */
  rawSnapshot?: string;
  state?: string;
  owner?: string;
  hold?: "leases" | "persist" | "detached";
  pids?: number[];
  createdAt?: number;
  startedAt?: number;
  command?: string;
  log?: string;
}

// Copied from omp 19.0.0 `packages/coding-agent/src/daemon/store.ts`.
const UNITS_TABLE = `CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  policy TEXT NOT NULL,
  proc TEXT,
  env_hash TEXT,
  snapshot TEXT NOT NULL,
  pid INTEGER,
  pid_started_at INTEGER,
  child_fds TEXT,
  module_state TEXT,
  output_offset INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  completion TEXT NOT NULL DEFAULT '{"capable":false}',
  pending_completions TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
)`;

/** Writes (or overwrites) units in `<daemonDir>/daemon.db` and their `output.log` files. */
export async function writeDaemonUnits(
  daemonDir: string,
  units: readonly DaemonUnitFixture[],
  project = "/workspace/project",
): Promise<void> {
  await mkdir(daemonDir, { recursive: true });
  const database = new DatabaseSync(join(daemonDir, "daemon.db"));
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(UNITS_TABLE);
    const insert = database.prepare(
      `INSERT OR REPLACE INTO units (id, kind, scope, scope_key, key, label, policy, proc, snapshot, pid, owner, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const unit of units) {
      // omp keys a project scope by its canonical path (`path.resolve`, a drive path on Windows).
      const scopeKey = unit.scopeKey ?? `project:${resolve(project)}`;
      const scope = scopeKey.startsWith("project:")
        ? { kind: "project", dir: scopeKey.slice("project:".length) }
        : { kind: "global" };
      const policy = {
        hold: unit.hold ?? "persist",
        idleMs: 0,
        onIdle: "stop",
        restart: "no",
        survive: "exec",
      };
      // A named service is omp re-entering itself as a shell process (`exec/shell-process.ts`).
      const proc = {
        application: "/usr/local/bin/omp",
        args: ["__omp_worker_shell_process", "--", unit.command ?? "sleep 3600"],
        env: {},
        cwd: project,
        pty: false,
      };
      // `units.ts` stores the raw launch line, wrapper included.
      const command = [proc.application, ...proc.args].join(" ");
      const snapshot = {
        id: unit.id,
        kind: unit.kind ?? "proc",
        scope,
        key: unit.key,
        label: unit.key,
        generation: "1",
        state: unit.state ?? "running",
        pids: unit.pids ?? [],
        createdAt: unit.createdAt ?? 1,
        startedAt: unit.startedAt ?? 2,
        restartCount: 0,
        outputBytes: 0,
        owner: unit.owner,
        leases: 0,
        policy,
        command,
        cwd: project,
        supervised: true,
      };
      insert.run(
        unit.id,
        unit.kind ?? "proc",
        JSON.stringify(scope),
        scopeKey,
        unit.key,
        unit.key,
        JSON.stringify(policy),
        JSON.stringify(proc),
        unit.rawSnapshot ?? JSON.stringify(snapshot),
        unit.pids?.[0] ?? null,
        unit.owner ?? null,
        Date.now(),
      );
      if (unit.log !== undefined) {
        const logDir = join(daemonDir, "units", unit.id);
        await mkdir(logDir, { recursive: true });
        await writeFile(join(logDir, "output.log"), unit.log);
      }
    }
  } finally {
    database.close();
  }
}
