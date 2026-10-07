import type { HubProcess } from "../shared/hub";
import { isOmpProfileName, type OmpStore } from "../shared/omp-store";
import { hubProcessTone } from "./hub-status";

/** The config screen keeps the id of the retired 0.10 sidebar item so saved links work. */
export const CONFIG_SCREEN_ID = "config";
export const HUB_SIDEBAR_ITEM_ID = "hub";

type ScreenParams = Readonly<Record<string, string>>;

/** A `profile` screen param selects that store; anything invalid falls back to the default. */
export function configStoreFromParams(params: ScreenParams | undefined): OmpStore | undefined {
  const profile = params?.profile?.trim();
  return profile && isOmpProfileName(profile) ? { profile } : undefined;
}

export function configParamsFromStore(store: OmpStore | undefined): Record<string, string> {
  return store?.profile ? { profile: store.profile } : {};
}

export function configScreenTitle(params: ScreenParams): string {
  const store = configStoreFromParams(params);
  return store?.profile ? `OMP · ${store.profile}` : "OMP";
}

export interface HubWorkspaceProcesses {
  cwd: string;
  processes: readonly HubProcess[];
}

export interface HubSidebarSummary {
  running: number;
  failed: number;
  total: number;
}

export function summarizeHubWorkspaces(
  workspaces: readonly HubWorkspaceProcesses[],
): HubSidebarSummary {
  const summary: HubSidebarSummary = { running: 0, failed: 0, total: 0 };
  for (const { processes } of workspaces) {
    for (const process of processes) {
      summary.total += 1;
      const tone = hubProcessTone(process);
      if (tone === "success") summary.running += 1;
      else if (tone === "danger") summary.failed += 1;
    }
  }
  return summary;
}

/** Distinct, non-empty workspace directories in first-seen order, bounded for polling cost. */
export function workspaceDirectories(
  workspaces: ReadonlyArray<{ workspaceDirectory?: string; projectRootPath: string }>,
  limit = 50,
): { directories: string[]; truncated: boolean } {
  const directories = new Set<string>();
  for (const workspace of workspaces) {
    const directory = workspace.workspaceDirectory || workspace.projectRootPath;
    if (!directory || directories.has(directory)) continue;
    if (directories.size >= limit) return { directories: [...directories], truncated: true };
    directories.add(directory);
  }
  return { directories: [...directories], truncated: false };
}

export interface HubSnapshot {
  workspaces: HubWorkspaceProcesses[];
  /** More workspaces exist than were polled; counts are a lower bound. */
  truncated: boolean;
  /** Workspaces whose hub state could not be read this poll. */
  unreadable: number;
}

/**
 * One poll of hub state. A failing workspace never hides the others; the poll fails only when
 * the workspace list itself fails or every workspace is unreadable.
 */
export async function loadHubSnapshot(
  listWorkspaces: () => Promise<{
    entries: ReadonlyArray<{ workspaceDirectory?: string; projectRootPath: string }>;
    pageInfo?: { hasMore?: boolean };
  }>,
  listProcesses: (cwd: string) => Promise<readonly HubProcess[]>,
): Promise<HubSnapshot> {
  const page = await listWorkspaces();
  const { directories, truncated } = workspaceDirectories(page.entries);
  const results = await Promise.allSettled(
    directories.map(async (cwd) => ({ cwd, processes: await listProcesses(cwd) })),
  );
  const workspaces: HubWorkspaceProcesses[] = [];
  for (const result of results) if (result.status === "fulfilled") workspaces.push(result.value);
  if (directories.length > 0 && workspaces.length === 0) {
    throw new Error("OMP hub state is unreadable");
  }
  return {
    workspaces,
    truncated: truncated || page.pageInfo?.hasMore === true,
    unreadable: directories.length - workspaces.length,
  };
}

export interface HubTrailing {
  running?: string;
  failed?: string;
  /** Some or all hub state could not be read. */
  unreadable: boolean;
  accessibilityLabel: string;
}

/** What the Hub row's trailing slot shows; null when there is nothing to report. */
export function hubTrailing(
  snapshot: HubSnapshot | undefined,
  loadFailed: boolean,
): HubTrailing | null {
  const summary = summarizeHubWorkspaces(snapshot?.workspaces ?? []);
  const atLeast = snapshot?.truncated ? "+" : "";
  const unreadable = loadFailed || (snapshot?.unreadable ?? 0) > 0;
  if (summary.total === 0 && !unreadable) return null;
  const running = summary.total > 0 ? `${summary.running}${atLeast} running` : undefined;
  const failed = summary.failed > 0 ? `${summary.failed}${atLeast} failed` : undefined;
  return {
    ...(running ? { running } : {}),
    ...(failed ? { failed } : {}),
    unreadable,
    accessibilityLabel: [running, failed, unreadable ? "some hub state unreadable" : undefined]
      .filter(Boolean)
      .join(", "),
  };
}
