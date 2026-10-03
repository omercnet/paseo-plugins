import type { HubProcess } from "../shared/hub";
import { isOmpProfileName, type OmpStore } from "../shared/omp-store";
import { hubProcessTone } from "./hub-status";

/** The sidebar id the 0.10 `addSidebarItem` used; the 0.11 screen keeps it so saved links work. */
export const CONFIG_SCREEN_ID = "config";
export const HUB_SIDEBAR_ITEM_ID = "hub";

type ScreenParams = Readonly<Record<string, string>>;

/**
 * The 0.11 screen/sidebar-item API, typed structurally so 0.9/0.10 SDK typechecks still compile.
 * On 0.10 hosts these members are absent at runtime.
 */
export interface ScreenCapableClient {
  addScreen(contribution: {
    id: string;
    title: string | ((params: ScreenParams) => string);
    Component: (props: never) => unknown;
  }): () => void;
  addSidebarHeaderItem(contribution: {
    id: string;
    title: string;
    Component: (props: never) => unknown;
  }): () => void;
  openScreen(input: { screenId: string; params?: Record<string, string> }): void;
}

/** True only on Paseo 0.11+ hosts, which provide screens, header items, and `openScreen`. */
export function supportsScreens<Client extends object>(
  client: Client,
): client is Client & ScreenCapableClient {
  const candidate = client as Partial<Record<keyof ScreenCapableClient, unknown>>;
  return (
    typeof candidate.addScreen === "function" &&
    typeof candidate.addSidebarHeaderItem === "function" &&
    typeof candidate.openScreen === "function"
  );
}

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
): string[] {
  const directories = new Set<string>();
  for (const workspace of workspaces) {
    const directory = workspace.workspaceDirectory || workspace.projectRootPath;
    if (directory) directories.add(directory);
    if (directories.size >= limit) break;
  }
  return [...directories];
}
