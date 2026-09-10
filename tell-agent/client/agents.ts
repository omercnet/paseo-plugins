import type { PaseoAgent, PaseoAgentListResult, PaseoApi } from "@getpaseo/client";

export type AgentEntry = PaseoAgentListResult["entries"][number];
type AgentSnapshot = PaseoAgent;

export const AGENT_PAGE_LIMIT = 200;
export const MAX_AGENT_PAGES = 10;

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
