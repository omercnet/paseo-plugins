import type {
  PaseoAgent,
  PaseoAgentListResult,
  PaseoAgentUpdate,
  PaseoApi,
} from "@getpaseo/client";

type PaseoApi = PluginClientContext["paseo"];
export type AgentEntry = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number];
type AgentSnapshot = AgentEntry["agent"];

export const AGENT_PAGE_LIMIT = 200;
export const MAX_AGENT_PAGES = 10;
const REOPEN_MIN_MS = 2_000;
const REOPEN_MAX_MS = 60_000;

export type AgentDirectoryPage = {
  entries: AgentEntry[];
  truncated: boolean;
};

export async function loadAgents(paseo: PaseoApi): Promise<AgentDirectoryPage> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AGENT_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: AGENT_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}

/**
 * Continues `loadAgents` from an observation's first page, to the same cap.
 * Returns null once `current()` turns false, so a stale read is dropped.
 */
async function readRemainingPages(
  paseo: PaseoApi,
  first: PaseoAgentListResult,
  current: () => boolean,
): Promise<AgentDirectoryPage | null> {
  const entries = [...first.entries];
  let cursor = first.pageInfo.hasMore ? (first.pageInfo.nextCursor ?? undefined) : undefined;
  for (let page = 1; cursor; page += 1) {
    if (page >= MAX_AGENT_PAGES) return { entries, truncated: true };
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: AGENT_PAGE_LIMIT, cursor },
    });
    if (!current()) return null;
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  }
  return { entries, truncated: false };
}

export type AgentDirectoryFollower = {
  /**
   * The directory as listed. `complete` means it holds every agent the host
   * has, so anything missing is gone; otherwise apply it as upserts only.
   */
  snapshot(agents: AgentSnapshot[], complete: boolean): void;
  upsert(agent: AgentSnapshot): void;
  remove(agentId: string): void;
};

/**
 * `observeEvents` shipped together with owned observations (0.9.0-beta.1). A
 * 0.8 client must not send `subscribe`: the daemon keeps one agents slot per
 * legacy connection, last query wins, so it would replace the app's own.
 */
function ownsObservations(paseo: PaseoApi): boolean {
  return typeof (paseo as { observeEvents?: unknown }).observeEvents === "function";
}

/**
 * Keeps `follower` in step with the host's agents until the returned cleanup.
 *
 * On 0.9, `agents.subscribe()` only hears observations the same API instance
 * opened, so this opens one with `list({ subscribe: {} })`. Its snapshot, the
 * first page, arrives first and again after every reconnect; later pages are
 * read plainly, and updates that land meanwhile win over what those pages say.
 * Paseo releases an observation that fails, so it is reopened with backoff.
 *
 * On 0.8 it listens and reads the directory once, as before.
 */
export function followAgentDirectory(
  paseo: PaseoApi,
  follower: AgentDirectoryFollower,
): () => void {
  let stopped = false;
  const apply = (update: PaseoAgentUpdate) => {
    if (update.kind === "remove") follower.remove(update.agentId);
    else follower.upsert(update.agent);
  };

  if (!ownsObservations(paseo)) {
    const unsubscribe = paseo.agents.subscribe((update) => {
      if (!stopped) apply(update);
    });
    void loadAgents(paseo)
      .then(({ entries }) => {
        if (stopped) return;
        const agents = entries.map((entry) => entry.agent);
        follower.snapshot(agents, false);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  const lifetime = new AbortController();
  let observation: { release(): Promise<void> } | null = null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  let reopenDelay = REOPEN_MIN_MS;
  /** Bumped per snapshot, so a reconnect abandons the paging of the one before. */
  let generation = 0;
  /** What updates said while the current snapshot's later pages were read. */
  let landed: Map<string, AgentSnapshot | null> | null = null;

  const applySnapshot = async (first: PaseoAgentListResult) => {
    const current = ++generation;
    const isCurrent = () => !stopped && generation === current;
    const touched = new Map<string, AgentSnapshot | null>();
    landed = touched;
    let listed: AgentDirectoryPage | null;
    try {
      listed = await readRemainingPages(paseo, first, isCurrent);
    } catch {
      listed = { entries: [...first.entries], truncated: true };
    }
    if (!listed || !isCurrent()) return;
    landed = null;
    const agents = new Map(listed.entries.map((entry) => [entry.agent.id, entry.agent]));
    for (const [agentId, agent] of touched) {
      if (agent) agents.set(agentId, agent);
      else agents.delete(agentId);
    }
    follower.snapshot([...agents.values()], !listed.truncated);
  };

  const reopen = () => {
    observation = null;
    if (stopped || reopenTimer !== null) return;
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      open();
    }, reopenDelay);
    reopenDelay = Math.min(reopenDelay * 2, REOPEN_MAX_MS);
  };

  const open = () => {
    paseo.agents
      .list({
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: AGENT_PAGE_LIMIT },
        subscribe: {},
        signal: lifetime.signal,
      })
      .then(({ subscription }) => {
        if (stopped) return;
        observation = subscription;
        subscription.subscribe({
          snapshot: (first) => {
            reopenDelay = REOPEN_MIN_MS;
            void applySnapshot(first);
          },
          update: (message) => {
            if (stopped || message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "remove") landed?.set(update.agentId, null);
            else landed?.set(update.agent.id, update.agent);
            apply(update);
          },
          error: reopen,
        });
      })
      .catch(reopen);
  };

  open();
  return () => {
    stopped = true;
    lifetime.abort();
    if (reopenTimer !== null) clearTimeout(reopenTimer);
    reopenTimer = null;
    void observation?.release().catch(() => undefined);
    observation = null;
  };
}

export function title(entry: AgentEntry): string {
  const explicit = entry.agent.title?.trim();
  return explicit && explicit.length > 0 ? explicit : entry.agent.id.slice(0, 7);
}

export function placement(entry: AgentEntry): string {
  const { project } = entry;
  const workspace = project.workspaceName?.trim();
  const scope =
    workspace && workspace !== project.projectName
      ? `${project.projectName} / ${workspace}`
      : project.projectName;
  const branch = project.checkout.isGit ? project.checkout.currentBranch : null;
  return branch ? `${scope} · ${branch}` : scope;
}

export function stateLabel(agent: AgentSnapshot): string {
  const permissionCount = agent.pendingPermissions.length;
  if (permissionCount > 0) {
    return permissionCount === 1 ? "permission" : `${permissionCount} permissions`;
  }
  if (agent.status === "error") return "error";
  if (agent.requiresAttention) return agent.attentionReason ?? "attention";
  return agent.status === "initializing" ? "starting" : agent.status;
}

export function matches(entry: AgentEntry, needle: string): boolean {
  if (needle.length === 0) return true;
  return [
    entry.agent.title ?? "",
    entry.agent.id,
    entry.agent.provider,
    entry.agent.model ?? "",
    entry.agent.cwd,
    entry.project.projectName,
    entry.project.workspaceName ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
