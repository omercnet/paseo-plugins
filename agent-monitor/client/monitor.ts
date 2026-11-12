import type { getPaseoClient } from "@getpaseo/plugin/client";
import type { AgentSort, MonitorSettings } from "../shared/monitor-settings";

// getPaseoClient() returns the bare client API; usePaseo() returns a superset, so both fit.
// Derived from the host SDK: shipped code must not import @getpaseo/client, a devDependency (#581).
export type PaseoApi = ReturnType<typeof getPaseoClient>;
export type PaseoWorkspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
export type AgentEntry = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number];
type AgentSnapshot = AgentEntry["agent"];
export type WorkspaceSummary = {
  id: string;
  navigationId: string | null;
  name: string;
  projectId: string;
  projectName: string;
  pinned: boolean;
  labels: readonly string[];
  additions: number;
  deletions: number;
};

/** A project registered on the daemon, named by its owner rather than by a workspace row. */
export type ProjectSummary = {
  id: string;
  name: string;
};

/** Registered projects indexed by project id and by the project key agents report. */
export type ProjectIndex = ReadonlyMap<string, ProjectSummary>;

/** Everything the roster needs beyond the agents themselves. */
export type MonitorDirectory = {
  workspaces: ReadonlyMap<string, WorkspaceSummary>;
  projects: ProjectIndex;
};

export type HostScope = {
  serverId: string;
  label: string;
};

export const HOST_PALETTE = ["#7aa2f7", "#bb9af7", "#7dcfff", "#9ece6a", "#e0af68", "#f7768e"];

/** A stable accent color per host, derived from the server id. */
export function hostColor(scope: HostScope | null): string {
  if (!scope) return "#8b8b8b";
  let hash = 0;
  for (let index = 0; index < scope.serverId.length; index += 1) {
    hash = (hash * 31 + scope.serverId.charCodeAt(index)) | 0;
  }
  return HOST_PALETTE[Math.abs(hash) % HOST_PALETTE.length] ?? "#8b8b8b";
}

/** Entries tagged by the host they were listed from; untagged entries predate the merge. */
export type ScopedAgentEntry = AgentEntry & { hostScope?: HostScope };

export function withHostScope(entry: AgentEntry, host: HostScope): ScopedAgentEntry {
  return { ...entry, hostScope: host };
}

export function hostOf(entry: AgentEntry): HostScope | null {
  const scope = (entry as ScopedAgentEntry).hostScope;
  return scope && typeof scope.serverId === "string" ? scope : null;
}

/**
 * The project index key for an entry's host. Project keys repeat across hosts (the same repo
 * registered on two daemons), so a merged directory indexes each host's projects under its server
 * id. Unscoped entries and single-host directories use the bare key.
 */
export function projectIndexKey(host: HostScope | null, key: string): string {
  return host ? `${host.serverId}\u0000${key}` : key;
}

/**
 * Indexes each project under its id and its key so either identifier resolves it. A project whose
 * key collides with another project's id overwrites that entry, so the last one listed wins.
 */
export function indexProjects(
  projects: readonly { id: string; key?: string | null; name: string }[],
): ProjectIndex {
  const index = new Map<string, ProjectSummary>();
  for (const project of projects) {
    const summary: ProjectSummary = { id: project.id, name: project.name };
    index.set(project.id, summary);
    if (project.key) index.set(project.key, summary);
  }
  return index;
}

export type WorkspaceGroup = { workspace: WorkspaceSummary; entries: AgentEntry[] };

export type ProjectGroup = {
  id: string;
  name: string;
  pinned: boolean;
  workspaces: WorkspaceGroup[];
};

/** A plain group the roster renders with one header: a host or an agent provider. */
export type NamedGroup = {
  id: string;
  name: string;
  entries: AgentEntry[];
};

export type Roster =
  | { kind: "compact"; entries: AgentEntry[] }
  | { kind: "workspace"; groups: WorkspaceGroup[] }
  | { kind: "project"; projects: ProjectGroup[] }
  | { kind: "host"; groups: NamedGroup[] }
  | { kind: "provider"; groups: NamedGroup[] };

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The agent's parent as a (host, agent) pair, or null for a root. The agent id prefers the
 * first-class snapshot field and falls back to the parent label. An absent server label means the
 * parent lives on `hostId`, the host being monitored.
 */
export function parentAddress(
  agent: AgentSnapshot,
  hostId: string,
): { serverId: string; agentId: string } | null {
  const agentId =
    trimmed("parentAgentId" in agent ? agent.parentAgentId : null) ??
    trimmed(agent.labels?.[PARENT_AGENT_ID_LABEL]);
  if (!agentId) return null;
  return { serverId: trimmed(agent.labels?.[PARENT_SERVER_ID_LABEL]) ?? hostId, agentId };
}

/** The parent's id when it is an agent on this host; null for roots and for cross-host children. */
export function parentAgentId(agent: AgentSnapshot, hostId: string): string | null {
  const parent = parentAddress(agent, hostId);
  return parent?.serverId === hostId ? parent.agentId : null;
}

/** The other host that delegated this agent, or null when it has no parent or a local one. */
export function delegatedFromServerId(agent: AgentSnapshot, hostId: string): string | null {
  const parent = parentAddress(agent, hostId);
  return parent && parent.serverId !== hostId ? parent.serverId : null;
}

export type Bucket = "attention" | "running" | "idle" | "closed";

export const BUCKETS: readonly Bucket[] = ["attention", "running", "idle", "closed"];
export const BUCKET_TITLES: Record<Bucket, string> = {
  attention: "Attention",
  running: "Running",
  idle: "Idle",
  closed: "Closed",
};

const BUCKET_ORDER: Record<Bucket, number> = { attention: 0, running: 1, idle: 2, closed: 3 };

export type GroupOptions = Pick<MonitorSettings, "floatPinned" | "agentSort"> & {
  /** The monitored host; parent links to any other host do not resolve against local agents. */
  hostId: string;
};

// `background` and `backgroundWork` are Paseo 0.16 fields; read them structurally so the plugin
// still typechecks against the older SDK lines its manifest supports.

/**
 * A background helper the agent's creator spawned: Paseo hides it from tabs, lists and attention,
 * so the monitor leaves it out of the roster, totals, badge and sweep. Hosts before 0.16 omit it.
 */
export function isHelper(agent: AgentSnapshot): boolean {
  return "background" in agent && agent.background === true;
}

/** Shells and monitors the agent left running after its turn; 0 on hosts that do not report it. */
export function backgroundWorkCount(agent: AgentSnapshot): number {
  const work: unknown = "backgroundWork" in agent ? agent.backgroundWork : undefined;
  if (typeof work !== "object" || work === null || !("count" in work)) return 0;
  return typeof work.count === "number" ? work.count : 0;
}

export function bucketOf(agent: AgentSnapshot): Bucket {
  if (agent.status === "closed") return "closed";
  if (agent.status === "error" || agent.pendingPermissions.length > 0) return "attention";
  const working = backgroundWorkCount(agent) > 0;
  // Live background work outranks only a "finished" attention. Paseo's deriveAgentStateBucket also
  // ranks it above attention with no reason; the monitor keeps that, errors and permissions here.
  if (agent.requiresAttention && !(working && agent.attentionReason === "finished")) {
    return "attention";
  }
  if (agent.status === "running" || agent.status === "initializing" || working) return "running";
  return "idle";
}

/**
 * The screen's `bucket` param: a bucket id, or "all" for no filter. Anything else (missing,
 * stale link, typo) is `undefined` so the caller falls back to the user's default bucket.
 */
export function parseBucketParam(value: string | undefined): Bucket | null | undefined {
  if (value === "all") return null;
  return BUCKETS.find((bucket) => bucket === value);
}

/** The lean row the sidebar popover needs. Its fields change only when the row visibly changes. */
export type AttentionItem = {
  id: string;
  title: string;
  state: string;
  since: number;
  detail: string;
  host: HostScope | null;
};

/** Agents in the attention bucket, longest-waiting first. Uses the same `bucketOf` as the screen. */
export function attentionItems(entries: readonly AgentEntry[]): AttentionItem[] {
  return entries
    .filter((entry) => bucketOf(entry.agent) === "attention")
    .map((entry) => ({
      id: entry.agent.id,
      title: title(entry),
      state: stateLabel(entry.agent),
      since: waitingSince(entry.agent),
      detail: entry.agent.model
        ? `${entry.agent.provider} · ${entry.agent.model}`
        : entry.agent.provider,
      host: hostOf(entry),
    }))
    .sort((left, right) => left.since - right.since);
}

/**
 * The count to show, or null when it cannot be trusted: still loading, or a failed host left no
 * rows at all. Otherwise a truncated roster or a failed host makes the count a lower bound,
 * because the missing rows might include agents that need attention.
 */
export function attentionCount(state: {
  items: readonly AttentionItem[] | undefined;
  truncated: boolean;
  failed: boolean;
  loading?: boolean;
}): { count: number; lowerBound: boolean } | null {
  if (!state.items || state.loading) return null;
  if (state.items.length === 0 && state.failed) return null;
  return { count: state.items.length, lowerBound: state.truncated || state.failed };
}

export function stateLabel(agent: AgentSnapshot): string {
  const permissionCount = agent.pendingPermissions.length;
  if (permissionCount > 0) {
    return permissionCount === 1 ? "permission" : `${permissionCount} permissions`;
  }
  if (agent.status === "error") return "error";
  const betweenTurns = agent.status !== "running" && agent.status !== "initializing";
  if (betweenTurns && bucketOf(agent) === "running") {
    return `${backgroundWorkCount(agent)} in background`;
  }
  if (agent.requiresAttention) return agent.attentionReason ?? "attention";
  return agent.status === "initializing" ? "starting" : agent.status;
}

/** Attention timestamp is when the agent started waiting; updatedAt is the fallback heartbeat. */
export function waitingSince(agent: AgentSnapshot): number {
  return Date.parse(agent.attentionTimestamp ?? agent.updatedAt);
}

export function age(since: number, now: number): string {
  if (Number.isNaN(since)) return "";
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
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

export function title(entry: AgentEntry): string {
  const explicit = entry.agent.title?.trim();
  return explicit && explicit.length > 0 ? explicit : entry.agent.id.slice(0, 7);
}

export function matches(entry: AgentEntry, needle: string): boolean {
  if (needle.length === 0) return true;
  return [
    hostOf(entry)?.label ?? "",
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

function bestBucket(entries: readonly AgentEntry[]): number {
  if (entries.length === 0) return BUCKET_ORDER.idle;
  return Math.min(...entries.map((entry) => BUCKET_ORDER[bucketOf(entry.agent)]));
}

function compareBySort(left: AgentEntry, right: AgentEntry, agentSort: AgentSort): number {
  if (agentSort === "title") return title(left).localeCompare(title(right));
  if (agentSort === "updated") {
    return Date.parse(right.agent.updatedAt) - Date.parse(left.agent.updatedAt);
  }
  const byBucket = BUCKET_ORDER[bucketOf(left.agent)] - BUCKET_ORDER[bucketOf(right.agent)];
  return byBucket === 0 ? waitingSince(right.agent) - waitingSince(left.agent) : byBucket;
}

/** `hostId` is the fallback for entries without a host scope; scoped entries resolve their own. */
export function sortEntries(entries: AgentEntry[], agentSort: AgentSort, hostId: string): void {
  const isChild = (entry: AgentEntry) =>
    parentAgentId(entry.agent, hostOf(entry)?.serverId ?? hostId) !== null;
  entries.sort((left, right) => {
    const leftChild = isChild(left);
    const rightChild = isChild(right);
    if (leftChild !== rightChild) return leftChild ? 1 : -1;
    return compareBySort(left, right, agentSort);
  });
}

type SortOptions = Pick<MonitorSettings, "floatPinned" | "agentSort">;

function sortWorkspaces(workspaces: WorkspaceGroup[], options: SortOptions): void {
  workspaces.sort((left, right) => {
    if (options.floatPinned && left.workspace.pinned !== right.workspace.pinned) {
      return left.workspace.pinned ? -1 : 1;
    }
    if (options.agentSort === "title") {
      return left.workspace.name.localeCompare(right.workspace.name);
    }
    if (options.agentSort === "updated") {
      const leftUpdated = Math.max(
        0,
        ...left.entries.map((entry) => Date.parse(entry.agent.updatedAt)),
      );
      const rightUpdated = Math.max(
        0,
        ...right.entries.map((entry) => Date.parse(entry.agent.updatedAt)),
      );
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    } else {
      const byBucket = bestBucket(left.entries) - bestBucket(right.entries);
      if (byBucket !== 0) return byBucket;
    }
    return left.workspace.name.localeCompare(right.workspace.name);
  });
}

/**
 * A listed workspace per project key, so an agent whose own workspace is unlisted can borrow its
 * sibling's project identity instead of grouping under the raw key. This keeps the project roster
 * correct when the registry is empty or missing that project.
 */
function siblingsByProjectKey(
  entries: readonly AgentEntry[],
  workspaces: ReadonlyMap<string, WorkspaceSummary>,
): ReadonlyMap<string, WorkspaceSummary> {
  const siblings = new Map<string, WorkspaceSummary>();
  for (const entry of entries) {
    const key = projectIndexKey(hostOf(entry), entry.project.projectKey);
    if (siblings.has(key)) continue;
    const workspace = entry.agent.workspaceId ? workspaces.get(entry.agent.workspaceId) : undefined;
    if (workspace) siblings.set(key, workspace);
  }
  return siblings;
}

function resolveWorkspace(
  entry: AgentEntry,
  directory: MonitorDirectory,
  siblings: ReadonlyMap<string, WorkspaceSummary>,
): WorkspaceSummary {
  const navigationId = entry.agent.workspaceId ?? null;
  const workspaceId = navigationId ?? `agent:${entry.agent.id}`;
  const known = directory.workspaces.get(workspaceId);
  if (known) return known;
  const key = projectIndexKey(hostOf(entry), entry.project.projectKey);
  const project = directory.projects.get(key);
  const sibling = siblings.get(key);
  return {
    id: workspaceId,
    navigationId,
    name: entry.project.workspaceName?.trim() || entry.project.projectName,
    projectId: project?.id ?? sibling?.projectId ?? entry.project.projectKey,
    projectName: project?.name ?? sibling?.projectName ?? entry.project.projectName,
    pinned: false,
    labels: [],
    additions: 0,
    deletions: 0,
  };
}

function workspaceGroups(
  entries: readonly AgentEntry[],
  directory: MonitorDirectory,
  options: GroupOptions,
): WorkspaceGroup[] {
  const siblings = siblingsByProjectKey(entries, directory.workspaces);
  const groups = new Map<string, WorkspaceGroup>();
  for (const entry of entries) {
    const workspace = resolveWorkspace(entry, directory, siblings);
    const group = groups.get(workspace.id);
    if (group) group.entries.push(entry);
    else groups.set(workspace.id, { workspace, entries: [entry] });
  }
  const result = [...groups.values()];
  for (const group of result) sortEntries(group.entries, options.agentSort, options.hostId);
  sortWorkspaces(result, options);
  return result;
}

/** True when the sole workspace repeats the project name, so the UI can collapse that header. */
export function shouldCollapseWorkspace(
  project: ProjectGroup,
  workspace: WorkspaceSummary,
  enabled = true,
): boolean {
  return enabled && project.workspaces.length === 1 && workspace.name === project.name;
}

export function groupByWorkspace(
  entries: readonly AgentEntry[],
  directory: MonitorDirectory,
  options: GroupOptions,
): WorkspaceGroup[] {
  return workspaceGroups(entries, directory, options);
}

export function groupByProject(
  entries: readonly AgentEntry[],
  directory: MonitorDirectory,
  options: GroupOptions,
): ProjectGroup[] {
  const groups = workspaceGroups(entries, directory, options);

  const projects = new Map<string, ProjectGroup>();
  for (const group of groups) {
    const projectId = group.workspace.projectId || group.workspace.projectName;
    const existing = projects.get(projectId);
    if (existing) {
      existing.workspaces.push(group);
      if (group.workspace.pinned) existing.pinned = true;
      continue;
    }
    projects.set(projectId, {
      id: projectId,
      name:
        directory.projects.get(projectIndexKey(hostOf(group.entries[0]), projectId))?.name ??
        group.workspace.projectName,
      pinned: group.workspace.pinned,
      workspaces: [group],
    });
  }

  const result = [...projects.values()];
  for (const project of result) sortWorkspaces(project.workspaces, options);
  sortProjects(result, options);
  return result;
}

function sortProjects(projects: ProjectGroup[], options: SortOptions): void {
  projects.sort((left, right) => {
    if (options.floatPinned && left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (options.agentSort === "title") return left.name.localeCompare(right.name);
    if (options.agentSort === "updated") {
      const leftUpdated = Math.max(
        0,
        ...left.workspaces.flatMap((group) =>
          group.entries.map((entry) => Date.parse(entry.agent.updatedAt)),
        ),
      );
      const rightUpdated = Math.max(
        0,
        ...right.workspaces.flatMap((group) =>
          group.entries.map((entry) => Date.parse(entry.agent.updatedAt)),
        ),
      );
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    } else {
      const leftBucket = Math.min(...left.workspaces.map((group) => bestBucket(group.entries)));
      const rightBucket = Math.min(...right.workspaces.map((group) => bestBucket(group.entries)));
      if (leftBucket !== rightBucket) return leftBucket - rightBucket;
    }
    return left.name.localeCompare(right.name);
  });
}

/** Sorts groups the way the roster sorts workspaces: latest activity, name, or best bucket. */
function sortNamedGroups(groups: NamedGroup[], options: SortOptions): void {
  groups.sort((left, right) => {
    if (options.agentSort === "title") return left.name.localeCompare(right.name);
    if (options.agentSort === "updated") {
      const leftUpdated = Math.max(
        0,
        ...left.entries.map((entry) => Date.parse(entry.agent.updatedAt)),
      );
      const rightUpdated = Math.max(
        0,
        ...right.entries.map((entry) => Date.parse(entry.agent.updatedAt)),
      );
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    } else {
      const byBucket = bestBucket(left.entries) - bestBucket(right.entries);
      if (byBucket !== 0) return byBucket;
    }
    return left.name.localeCompare(right.name);
  });
}

function namedGroups(
  entries: readonly AgentEntry[],
  options: GroupOptions,
  keyOf: (entry: AgentEntry) => { id: string; name: string },
): NamedGroup[] {
  const groups = new Map<string, NamedGroup>();
  for (const entry of entries) {
    const { id, name } = keyOf(entry);
    const group = groups.get(id);
    if (group) group.entries.push(entry);
    else groups.set(id, { id, name, entries: [entry] });
  }
  const result = [...groups.values()];
  for (const group of result) sortEntries(group.entries, options.agentSort, options.hostId);
  sortNamedGroups(result, options);
  return result;
}

/** Groups agents by the daemon they run on. Unscoped entries fall under the monitored host. */
export function groupByHost(entries: readonly AgentEntry[], options: GroupOptions): NamedGroup[] {
  return namedGroups(entries, options, (entry) => {
    const scope = hostOf(entry);
    return scope
      ? { id: scope.serverId, name: scope.label }
      : { id: options.hostId, name: options.hostId };
  });
}

/** Groups agents by provider, so one row per agent type reads at a glance. */
export function groupByProvider(
  entries: readonly AgentEntry[],
  options: GroupOptions,
): NamedGroup[] {
  return namedGroups(entries, options, (entry) => ({
    id: entry.agent.provider,
    name: entry.agent.provider,
  }));
}

export function buildRoster(
  entries: readonly AgentEntry[],
  directory: MonitorDirectory,
  settings: Pick<MonitorSettings, "grouping" | "floatPinned" | "agentSort">,
  hostId: string,
): Roster {
  const options: GroupOptions = {
    floatPinned: settings.floatPinned,
    agentSort: settings.agentSort,
    hostId,
  };
  if (settings.grouping === "compact") {
    const pinned: AgentEntry[] = [];
    const rest: AgentEntry[] = [];
    for (const entry of entries) {
      if (settings.floatPinned && directory.workspaces.get(entry.agent.workspaceId ?? "")?.pinned) {
        pinned.push(entry);
      } else {
        rest.push(entry);
      }
    }
    sortEntries(pinned, settings.agentSort, hostId);
    sortEntries(rest, settings.agentSort, hostId);
    return { kind: "compact", entries: [...pinned, ...rest] };
  }
  if (settings.grouping === "workspace") {
    return { kind: "workspace", groups: groupByWorkspace(entries, directory, options) };
  }
  if (settings.grouping === "host") {
    return { kind: "host", groups: groupByHost(entries, options) };
  }
  if (settings.grouping === "provider") {
    return { kind: "provider", groups: groupByProvider(entries, options) };
  }
  return { kind: "project", projects: groupByProject(entries, directory, options) };
}

export function childCounts(
  entries: readonly AgentEntry[],
  hostId: string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const parentId = parentAgentId(entry.agent, hostId);
    if (parentId) counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The cross-host project name: registry display names may carry a per-host
 * suffix ("ACME · alpha") because the core sidebar cannot unify non-git
 * projects. The monitor groups by the base name so one project reads as one
 * group however many hosts list it.
 */
export function baseProjectName(name: string): string {
  const separator = name.indexOf(" · ");
  return separator < 0 ? name : name.slice(0, separator).trim() || name;
}

/** The graph panel key: like `placement` but on the base project name, so one project reads as one panel however many hosts list it. */
export function panelKey(entry: AgentEntry): string {
  const base = baseProjectName(entry.project.projectName);
  const workspace = entry.project.workspaceName?.trim();
  return workspace && workspace !== entry.project.projectName ? `${base} / ${workspace}` : base;
}

export type HostedProjectGroups = {
  host: HostScope;
  projects: ProjectGroup[];
};

/**
 * Merge per-host project groups by base name. Groups from different hosts that
 * share a base name become one group under that name; its workspaces keep their
 * host, which the UI reads back off each workspace's entries. Same-name projects
 * on one host stay apart (the n-th on each host pairs up), and a group that
 * merges with nothing keeps its own id and name.
 */
export function mergeProjectGroupsAcrossHosts(
  all: readonly HostedProjectGroups[],
  options: SortOptions,
): ProjectGroup[] {
  const merged = new Map<string, ProjectGroup>();
  for (const { projects } of all) {
    const seen = new Map<string, number>();
    for (const project of projects) {
      const name = baseProjectName(project.name);
      const occurrence = seen.get(name) ?? 0;
      seen.set(name, occurrence + 1);
      const key = `${name}#${occurrence}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...project, workspaces: [...project.workspaces] });
        continue;
      }
      existing.id = key;
      existing.name = name;
      existing.workspaces = [...existing.workspaces, ...project.workspaces];
      existing.pinned = existing.pinned || project.pinned;
    }
  }
  const result = [...merged.values()];
  for (const project of result) sortWorkspaces(project.workspaces, options);
  sortProjects(result, options);
  return result;
}
