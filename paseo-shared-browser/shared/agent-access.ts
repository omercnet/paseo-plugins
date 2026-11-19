/**
 * Which new agents get the Shared Browser tool.
 *
 * "all" injects the adapter into every new agent (the behaviour before this setting existed, and the
 * default). "listed" injects it only when the new agent matches an entry of one of four lists: its
 * provider id, the id of its workspace, the id of its workspace's project, or one of its labels. An empty configuration
 * means no agent. Agents that already exist are never changed, except that an agent chosen by label gets the tool in
 * every interactive session it opens, resumed ones included.
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
  labels: entries,
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
  labels: [],
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

/**
 * A directory in one lexical canonical form: backslashes become slashes, repeated slashes collapse, and
 * `.` and `..` segments resolve. An absolute path (a leading slash, or a drive such as `C:`) cannot
 * climb above its root, which is `/` or `C:/`. It is the same idea as posix normalize, written out because
 * shared code does not import Node modules. Nothing on disk is consulted: symlinks are not resolved and
 * letter case is not folded.
 */
export function normalizeDirectory(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(slashed)?.[0] ?? "";
  const rest = slashed.slice(drive.length);
  const absolute = drive !== "" || rest.startsWith("/");
  const kept: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      kept.push(segment);
    } else if (kept.length > 0 && kept[kept.length - 1] !== "..") {
      kept.pop();
    } else if (!absolute) {
      kept.push("..");
    }
  }
  const joined = kept.join("/");
  return absolute ? `${drive}/${joined}` : joined;
}

/** True for a normalized path that starts at a root (`/` or a drive such as `C:/`). A relative path never matches a workspace. */
export function isAbsoluteDirectory(normalized: string): boolean {
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

/**
 * The workspaces whose directory is the agent's directory, or the deepest directory that contains it.
 * Several workspaces can share one directory, so this returns all of them.
 */
export function workspacesForDirectory(
  cwd: string,
  workspaces: readonly WorkspaceRef[],
): WorkspaceRef[] {
  const target = normalizeDirectory(cwd);
  // Early exit only: a relative target can never equal or sit under an absolute workspace directory, so the loop below would find nothing.
  if (!isAbsoluteDirectory(target)) return [];
  let depth = -1;
  let found: WorkspaceRef[] = [];
  for (const workspace of workspaces) {
    if (!workspace.workspaceDirectory) continue;
    const directory = normalizeDirectory(workspace.workspaceDirectory);
    if (!isAbsoluteDirectory(directory)) continue;
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    if (target !== directory && !target.startsWith(prefix)) continue;
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

/**
 * True when one entry of `entries` matches the agent's labels. An entry is a label key (`team`: the agent has that
 * label, whatever its value) or `key=value` (the agent has that label with exactly that value). Matching is exact and
 * case-sensitive. An entry with an empty key never matches.
 */
export function labelMatches(
  entries: readonly string[],
  labels: Readonly<Record<string, string>>,
): boolean {
  return entries.some((entry) => {
    const separator = entry.indexOf("=");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    if (key === "" || !Object.hasOwn(labels, key)) return false;
    return separator < 0 || labels[key] === entry.slice(separator + 1);
  });
}

/**
 * True when an agent gets the browser tool because of its labels. Labels are only on the session-open request, not on
 * agent.create, so this runs there. It applies to the "listed" mode only; in "all" every new agent already has the tool.
 */
export function agentGetsBrowserByLabel(
  access: AgentAccess,
  labels: Readonly<Record<string, string>>,
): boolean {
  return access.mode === "listed" && labelMatches(access.labels, labels);
}

export const MAX_LIST_ENTRIES = MAX_ENTRIES;
export const MAX_LIST_ENTRY_LENGTH = MAX_ENTRY_LENGTH;

/**
 * The comma or line separated names typed in the settings screen. Repeats are dropped. A name over the
 * length limit or a list over the entry limit is reported in `error` instead of being cut off.
 */
export function parseEntries(text: string): { entries: string[]; error: string | null } {
  const entries: string[] = [];
  for (const piece of text.split(/[,\n]/)) {
    const name = piece.trim();
    if (name === "") continue;
    if (name.length > MAX_ENTRY_LENGTH) {
      return {
        entries: [],
        error: `An entry is longer than ${MAX_ENTRY_LENGTH} characters: ${name.slice(0, 24)}...`,
      };
    }
    if (!entries.includes(name)) entries.push(name);
  }
  if (entries.length > MAX_ENTRIES) {
    return {
      entries: [],
      error: `A list can hold ${MAX_ENTRIES} entries; this one has ${entries.length}.`,
    };
  }
  return { entries, error: null };
}
