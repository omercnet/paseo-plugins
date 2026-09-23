import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { type claimOpenedWorkspaces, claimUnclaimedWorkspaces } from "../shared/auto-open";

export interface AutoOpenStore {
  load(): Promise<ReadonlySet<string>>;
  persist(next: ReadonlySet<string>): Promise<void>;
}

export function autoOpenDataFilePath(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "agent-crew", "auto-open.json");
}

function parseWorkspaceIds(raw: string): Set<string> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("auto-open store must contain an array of workspace IDs");
  }
  const values = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("auto-open store must contain only non-empty string workspace IDs");
    }
    values.add(value);
  }
  return values;
}

export function createFileAutoOpenStore(filePath: string = autoOpenDataFilePath()): AutoOpenStore {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
        throw error;
      }
      try {
        return parseWorkspaceIds(raw);
      } catch (error) {
        console.error("Agent Crew auto-open store load failed", { filePath, error });
        throw error;
      }
    },
    async persist(next) {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify([...next], null, 2)}\n`, "utf8");
      await rename(temporary, filePath);
    },
  };
}

export function createMemoryAutoOpenStore(initial: Iterable<string> = []): AutoOpenStore {
  let values = new Set(initial);
  return {
    async load() {
      return new Set(values);
    },
    async persist(next) {
      values = new Set(next);
    },
  };
}

export function createAutoOpenClaimHandler(store: AutoOpenStore = createFileAutoOpenStore()) {
  let chain: Promise<unknown> = Promise.resolve();
  return async function handleClaim({ workspaceIds }: RpcInput<typeof claimOpenedWorkspaces>) {
    const run = async () => {
      const opened = await store.load();
      const claimed = claimUnclaimedWorkspaces(opened, workspaceIds);
      if (claimed.length === 0) return { claimed };
      const next = new Set(opened);
      for (const workspaceId of claimed) next.add(workspaceId);
      await store.persist(next);
      return { claimed };
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}
