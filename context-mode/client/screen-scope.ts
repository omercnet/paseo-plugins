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

export async function resolveKnowledgeScope(
  paseo: PaseoApi,
  params: ScreenParams,
): Promise<KnowledgeScope> {
  if (params.agentId) {
    const result = await paseo.agents.ref(params.agentId).refresh();
    if (!result)
      throw new Error("Agent not found on this host. Select a provider and project explicitly.");
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
  if (!workspace)
    throw new Error("Workspace not found on this host. Select a provider and project explicitly.");
  return {
    provider: null,
    projectPath: workspace.workspaceDirectory,
    note: "Select a provider store for this workspace.",
  };
}
