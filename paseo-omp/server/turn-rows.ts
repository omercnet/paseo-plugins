import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { addTurnHook } from "./hook-compat";

export interface OmpTurnRow {
  id: string;
  kind: string;
  data: JsonValue;
}

/** Reads one row from an OMP session file for the turn between `since` and `until` (epoch ms). */
export type OmpTurnRowReader = (
  sessionFile: string,
  since: number,
  until: number,
) => Promise<OmpTurnRow | undefined>;

export interface OmpTurnRowServer {
  addHook?: unknown;
  on?: unknown;
}

/**
 * Paseo's bundled `omp` provider drops parts of what OMP persists to its session file. After each
 * turn of such an agent, every reader may append one timeline row built from that file.
 *
 * Hosts from 0.15 on expose `addHook`; 0.14 hosts only fire the legacy `agent.turn_started` and
 * `agent.turn_ended` events, so registration is routed through the hook-compat layer.
 */
export function registerOmpTurnRows(
  server: OmpTurnRowServer,
  readers: readonly OmpTurnRowReader[],
): () => void {
  // One Paseo turn can report several native turn starts; keep the earliest. Hooks run
  // concurrently, so state is read and cleared before the first await.
  const turnStarts = new Map<string, number>();
  const turnKey = (agentId: string, turnId: string | null) => `${agentId}\0${turnId ?? ""}`;
  const removeBefore = addTurnHook(server, "agent.turn.before", async ({ agent, turnId }) => {
    const key = turnKey(agent.id, turnId);
    if (agent.provider === "omp" && !turnStarts.has(key)) turnStarts.set(key, Date.now());
  });
  const removeAfter = addTurnHook(
    server,
    "agent.turn.after",
    async ({ agent, turnId }, { paseo }) => {
      const key = turnKey(agent.id, turnId);
      const since = turnStarts.get(key);
      const until = Date.now();
      turnStarts.delete(key);
      if (agent.provider !== "omp" || since === undefined) return;
      const ref = paseo.agents.ref(agent.id);
      const sessionFile = (await ref.refresh())?.agent.persistence?.nativeHandle;
      if (!sessionFile) return;
      for (const read of readers) {
        const row = await read(sessionFile, since, until);
        if (!row) continue;
        await ref.timeline.append({
          type: "plugin",
          id: row.id,
          kind: row.kind,
          version: 1,
          data: row.data,
        });
      }
    },
  );
  return () => {
    removeBefore();
    removeAfter();
    turnStarts.clear();
  };
}
