import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  MAX_OMP_RULE_NOTICE_RULES,
  OMP_RULE_MATCH_MAX_LENGTH,
  OMP_RULE_NAME_MAX_LENGTH,
  OMP_RULE_NOTICE_KIND,
  type OmpRuleNotice,
} from "../shared/rule-notices";

/** Rule firings are read from the end of the session file; a turn rarely writes more. */
const TAIL_BYTES = 1024 * 1024;

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

async function readTail(file: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The OMP rules injected between `since` and `until` (epoch ms), from OMP's persisted
 * `ttsr_injection` entries; `id` is the first injection entry's.
 */
export async function readOmpRuleNotice(
  sessionFile: string,
  since: number,
  until: number,
): Promise<{ id: string; notice: OmpRuleNotice } | undefined> {
  if (!isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return;
  const tail = await readTail(sessionFile);
  if (!tail) return;
  let id: string | undefined;
  const names: string[] = [];
  const matched = new Map<string, string>();
  for (const line of tail.split("\n")) {
    if (!line.includes("ttsr")) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (!(at >= since && at <= until)) continue;
    if (entry.type === "ttsr_injection") {
      id ??= typeof entry.id === "string" ? entry.id : undefined;
      for (const name of stringArray(entry.injectedRules)) {
        if (!names.includes(name)) names.push(name);
      }
    } else if (entry.type === "custom_message" && entry.customType === "ttsr-injection") {
      const details = entry.details as { matched?: unknown } | undefined;
      if (details?.matched && typeof details.matched === "object") {
        for (const [name, text] of Object.entries(details.matched)) {
          if (typeof text === "string") matched.set(name, text);
        }
      }
    }
  }
  if (!id || names.length === 0) return;
  return {
    id,
    notice: {
      rules: names.slice(0, MAX_OMP_RULE_NOTICE_RULES).map((name) => {
        const text = matched.get(name);
        return {
          name: bounded(name, OMP_RULE_NAME_MAX_LENGTH),
          matched: text === undefined ? null : bounded(text, OMP_RULE_MATCH_MAX_LENGTH),
        };
      }),
    },
  };
}

/** Paseo's bundled `omp` provider drops OMP rule events, so surface them from its session file. */
export function registerOmpRuleNotices(server: Pick<PluginServerContext, "addHook">): () => void {
  // One Paseo turn can report several native turn starts; keep the earliest. Hooks run
  // concurrently, so state is read and cleared before the first await.
  const turnStarts = new Map<string, number>();
  const turnKey = (agentId: string, turnId: string | null) => `${agentId}\0${turnId ?? ""}`;
  const removeBefore = server.addHook("agent.turn.before", async ({ agent, turnId }) => {
    const key = turnKey(agent.id, turnId);
    if (agent.provider === "omp" && !turnStarts.has(key)) turnStarts.set(key, Date.now());
  });
  const removeAfter = server.addHook("agent.turn.after", async ({ agent, turnId }, { paseo }) => {
    const key = turnKey(agent.id, turnId);
    const since = turnStarts.get(key);
    const until = Date.now();
    turnStarts.delete(key);
    if (agent.provider !== "omp" || since === undefined) return;
    const ref = paseo.agents.ref(agent.id);
    const sessionFile = (await ref.refresh())?.agent.persistence?.nativeHandle;
    if (!sessionFile) return;
    const found = await readOmpRuleNotice(sessionFile, since, until);
    if (!found) return;
    await ref.timeline.append({
      type: "plugin",
      id: `rule-notice:${found.id}`,
      kind: OMP_RULE_NOTICE_KIND,
      version: 1,
      data: found.notice,
    });
  });
  return () => {
    removeBefore();
    removeAfter();
    turnStarts.clear();
  };
}
