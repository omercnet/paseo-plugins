import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const sandboxRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  /** Opaque to everything but the provider that issued it; null until the first `up`. */
  handle: z.string().nullable(),
  /** The credential revision the sandbox was last started with. */
  revision: z.string().nullable(),
  /** The daemon password. Registered hosts store it too; the sandbox reads it as PASEO_PASSWORD. */
  password: z.string(),
  createdAt: z.string(),
});
export type SandboxRecord = z.infer<typeof sandboxRecordSchema>;

const stateSchema = z.object({
  credentials: z.record(z.string(), z.object({ value: z.string(), savedAt: z.string() })),
  sandboxes: z.record(z.string(), sandboxRecordSchema),
});
export type State = z.infer<typeof stateSchema>;

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env) {
  const home = env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "plugin-data", "sandbox", "state.json");
}

/**
 * Credentials and sandbox bindings in one private file beside the other plugin data. Writes are
 * serialized and atomic. Plugin settings are not an option: they are readable by every client.
 */
export class Store {
  private state: State | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<State> {
    if (this.state) return this.state;
    try {
      const parsed = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      // An update may have published newer state while this read was in flight.
      this.state ??= parsed;
    } catch (error) {
      if (!isMissingFile(error)) {
        // Never start from empty over a file we could not read: that would discard credentials.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Sandbox state at ${this.path} is unreadable: ${reason}`);
      }
      this.state ??= { credentials: {}, sandboxes: {} };
    }
    return this.state;
  }

  /** Applies `change` to a copy, persists it, then publishes it. A failed write changes nothing. */
  update<T>(change: (draft: State) => T): Promise<T> {
    const run = async () => {
      const draft = structuredClone(await this.read());
      const result = change(draft);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(draft), { mode: 0o600 });
        await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      this.state = draft;
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
