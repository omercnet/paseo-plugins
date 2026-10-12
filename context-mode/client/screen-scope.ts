import type { PluginClientContext } from "@getpaseo/plugin/client";

type PaseoApi = PluginClientContext["paseo"];

export type SurfaceTab = "savings" | "knowledge" | "setup";
export type KnowledgeScope = {
  provider: string | null;
  projectPath: string;
  note?: string;
};

export type ScreenParams = { section: SurfaceTab; agentId?: string; workspaceId?: string };
export function parseScreenParams(params: Record<string, string>): ScreenParams {
  const section: SurfaceTab =
    params.section === "knowledge" || params.section === "setup" ? params.section : "savings";
  return {
    section,
    agentId: params.agentId || undefined,
    workspaceId: params.workspaceId || undefined,
  };
}

// Screen params survive the host switcher and shared links, so the id may belong to another host.
function notOnThisHost(kind: "agent" | "workspace"): KnowledgeScope {
  return {
    provider: null,
    projectPath: "",
    note: `The ${kind} this screen was opened from is not on this host. Select a provider and project.`,
  };
}

export async function resolveKnowledgeScope(
  paseo: PaseoApi,
  params: ScreenParams,
): Promise<KnowledgeScope> {
  if (params.agentId) {
    const result = await paseo.agents.ref(params.agentId).refresh();
    if (!result) return notOnThisHost("agent");
    if (params.workspaceId && result.agent.workspaceId !== params.workspaceId) {
      throw new Error(
        "Agent no longer belongs to this workspace. Select a provider and project explicitly.",
      );
    }
    return { provider: result.agent.provider, projectPath: result.agent.cwd };
  }
  const workspace = params.workspaceId
    ? await paseo.workspaces.ref(params.workspaceId).refresh()
    : null;
  if (!workspace) return notOnThisHost("workspace");
  return {
    provider: null,
    projectPath: workspace.workspaceDirectory,
    note: "Select a provider store for this workspace.",
  };
}
