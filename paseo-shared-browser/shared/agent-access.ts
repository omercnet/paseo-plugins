/**
 * Which new agents get the Shared Browser tool.
 *
 * "all" injects the adapter into every new agent (the behaviour before this setting existed, and the
 * default). "listed" injects it only when the new agent matches an entry of one of three lists: its
 * provider id, the id of its workspace, or the id of its workspace's project. An empty configuration
 * means no agent. Agents that already exist are never changed.
 *
 * `agent.create` carries the provider and the working directory but no labels and no workspace id, so
 * the workspace is found by matching the directory against the daemon's workspaces.
 */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const AGENT_ACCESS_MODES = ["all", "listed"] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

const MAX_ENTRIES = 200;
const MAX_ENTRY_LENGTH = 256;
const entries = z.array(z.string().min(1).max(MAX_ENTRY_LENGTH)).max(MAX_ENTRIES).default([]);

export const agentAccessSchema = z.object({
  mode: z.enum(AGENT_ACCESS_MODES).default("all"),
  providers: entries,
  workspaces: entries,
  projects: entries,
});

export type AgentAccess = z.output<typeof agentAccessSchema>;

export const agentAccessSettings = defineSettings({
  id: "agent-access",
  scope: "host",
  version: 1,
  schema: agentAccessSchema,
});

/** Used when the setting cannot be read or fails validation. */
export const DEFAULT_AGENT_ACCESS: AgentAccess = {
  mode: "all",
  providers: [],
  workspaces: [],
  projects: [],
};

export function accessFromState(
  state: { status: "ready"; values: AgentAccess } | { status: string } | undefined,
): AgentAccess {
  return state?.status === "ready" && "values" in state ? state.values : DEFAULT_AGENT_ACCESS;
}

export interface NewAgent {
  provider: string;
  cwd: string;
}

export interface WorkspaceRef {
  id: string;
  projectId: string;
  workspaceDirectory?: string | undefined;
}

const trimEnd = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * The workspaces whose directory is the agent's directory, or the deepest directory that contains it.
 * Several workspaces can share one directory, so this returns all of them.
 */
export function workspacesForDirectory(
  cwd: string,
  workspaces: readonly WorkspaceRef[],
): WorkspaceRef[] {
  const target = trimEnd(cwd);
  let depth = -1;
  let found: WorkspaceRef[] = [];
  for (const workspace of workspaces) {
    if (!workspace.workspaceDirectory) continue;
    const directory = trimEnd(workspace.workspaceDirectory);
    if (target !== directory && !target.startsWith(`${directory}/`)) continue;
    if (directory.length > depth) {
      depth = directory.length;
      found = [workspace];
    } else if (directory.length === depth) {
      found.push(workspace);
    }
  }
  return found;
}

/**
 * True when a new agent gets the browser tool. `listWorkspaces` is called only when a workspace or
 * project is listed and the provider did not already match; if it throws, those lists do not match.
 */
export async function agentGetsBrowser(
  access: AgentAccess,
  agent: NewAgent,
  listWorkspaces: () => Promise<readonly WorkspaceRef[]>,
): Promise<boolean> {
  if (access.mode === "all") return true;
  if (access.providers.includes(agent.provider)) return true;
  if (access.workspaces.length === 0 && access.projects.length === 0) return false;
  try {
    return workspacesForDirectory(agent.cwd, await listWorkspaces()).some(
      (workspace) =>
        access.workspaces.includes(workspace.id) || access.projects.includes(workspace.projectId),
    );
  } catch {
    return false;
  }
}

/** The comma or line separated names typed in the settings screen. */
export function parseEntries(text: string): string[] {
  const names: string[] = [];
  for (const piece of text.split(/[,\n]/)) {
    const name = piece.trim();
    if (name !== "" && name.length <= MAX_ENTRY_LENGTH && !names.includes(name)) names.push(name);
  }
  return names.slice(0, MAX_ENTRIES);
}
