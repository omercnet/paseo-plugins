import type { PaseoApi } from "@getpaseo/client";
import type { Session } from "../shared/usage";

/** Re-reading every agent, archived ones included, is not free, so it is done sparingly. */
const FULL_REFRESH_MS = 30_000;
/** A session whose agent is not yet known may be a brand new agent; look again, but not constantly. */
const EARLY_REFRESH_MS = 5000;
/** Only the first ever fetch is waited for, and not forever. */
const FIRST_FETCH_TIMEOUT_MS = 3000;
const PAGE_SIZE = 200;
export const MAX_PAGES = 25;
export const MAX_SESSIONS = 10;

interface Load {
  cores: number;
  rss: number;
}

interface Known {
  agents: Map<string, { title: string | null; workspaceId: string | null }>;
  workspaces: Map<string, string>;
}

interface Page<T> {
  entries: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

/** The daemon pages its lists, and an agent left off the first page must still be recognised. */
async function collect<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>) {
  const entries: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    entries.push(...result.entries);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  return entries;
}

/**
 * The process scan sees every process the daemon's user owns, including agents that belong to other
 * daemons on the same machine. This keeps only the sessions of agents this daemon knows, names them
 * with the user's own agent and workspace names, and folds everything else into `other` so the
 * numbers still add up to the processes that were scanned.
 *
 * The daemon's lists are read in the background and shared between callers, so a slow daemon never
 * holds up the readings. Only the very first read is waited for, for a few seconds at most. Until
 * then, and whenever the lists have never been available, no session can be shown as this host's and
 * all of its load is reported as other load. Once read, a failed refresh keeps the last lists.
 */
export function createOwnership(now = Date.now, firstFetchTimeoutMs = FIRST_FETCH_TIMEOUT_MS) {
  let known: Known | null = null;
  /** Agents confirmed absent from the latest read, so they do not trigger another one. */
  let foreign = new Set<string>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const refresh = (paseo: PaseoApi, candidates: string[]) => {
    if (inflight) return inflight;
    fetchedAt = now();
    inflight = (async () => {
      try {
        const [agents, workspaces] = await Promise.all([
          collect((cursor) =>
            paseo.agents.list({
              filter: { includeArchived: true },
              // Oldest first: an agent's creation time never changes, so paging cannot skip one that
              // is busy and being updated while the pages are read.
              sort: [{ key: "created_at", direction: "asc" }],
              page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
            }),
          ),
          collect((cursor) =>
            paseo.workspaces.list({ page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } }),
          ),
        ]);
        const next: Known = {
          agents: new Map(
            agents.map(({ agent }) => [
              agent.id,
              { title: agent.title ?? null, workspaceId: agent.workspaceId ?? null },
            ]),
          ),
          workspaces: new Map(
            workspaces.map((workspace) => [workspace.id, workspace.title ?? workspace.name]),
          ),
        };
        known = next;
        foreign = new Set(candidates.filter((id) => !next.agents.has(id)));
      } catch {
        // Keep the previous lists.
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return async (paseo: PaseoApi, sessions: Session[], other: Load) => {
    if (sessions.length === 0) return { sessions, other };

    const ids = sessions.map((session) => session.agentId);
    const age = now() - fetchedAt;
    const unseen = ids.some((id) => !known?.agents.has(id) && !foreign.has(id));
    const pending =
      age >= FULL_REFRESH_MS || (unseen && age >= EARLY_REFRESH_MS)
        ? refresh(paseo, ids)
        : inflight;
    if (known === null && pending) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, firstFetchTimeoutMs);
        pending.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const rest = { ...other };
    const own: Session[] = [];
    for (const session of sessions) {
      const agent = known?.agents.get(session.agentId);
      if (!agent) {
        rest.cores += session.cores;
        rest.rss += session.rss;
        continue;
      }
      own.push({
        ...session,
        title: agent.title,
        workspace: (agent.workspaceId && known?.workspaces.get(agent.workspaceId)) || null,
      });
    }
    // Callers hand sessions over flagged first, then busiest, so the cap drops the least important.
    for (const session of own.slice(MAX_SESSIONS)) {
      rest.cores += session.cores;
      rest.rss += session.rss;
    }
    return { sessions: own.slice(0, MAX_SESSIONS), other: rest };
  };
}
