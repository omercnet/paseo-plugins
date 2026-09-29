import type {
  PluginButton,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";

export const CREW_PANEL_ID = "crew";
const BUTTON_ID = "open-crew";
const PAGE_LIMIT = 200;

// Workspace panels are opt-in per workspace, so without this the Crew tab only
// exists where someone opened it by hand. One header button per workspace fixes that.
export function registerCrewHeaderButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  // Removals seen while the initial listing runs; a later page may still carry them.
  const removedWhileListing = new Set<string>();
  let listing = true;
  let stopped = false;

  function track(workspaceId: string) {
    if (stopped || buttons.has(workspaceId)) return;
    const button: PluginButton = {
      title: "Open Agent Crew",
      icon: "Network",
      behavior: {
        kind: "action",
        onPress() {
          client.openPanel(CREW_PANEL_ID, { workspaceId, location: "explorer" });
        },
      },
    };
    try {
      buttons.set(workspaceId, client.addHeaderButton({ id: BUTTON_ID, workspaceId, button }));
    } catch (error) {
      console.warn(`[agent-crew] Could not add header button to ${workspaceId}`, error);
    }
  }

  function untrack(workspaceId: string) {
    if (listing) removedWhileListing.add(workspaceId);
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  }

  const unsubscribe = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") {
      removedWhileListing.delete(update.workspace.id);
      track(update.workspace.id);
    } else untrack(update.id);
  });

  void (async () => {
    // No page cap: every workspace needs its button. A repeated cursor ends the walk.
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; !stopped; page += 1) {
      const result = await client.paseo.workspaces.list({
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        // subscribe() above only listens; this asks the daemon to stream workspace
        // updates. The id is the host's to assign: sending one is rejected outright.
        ...(page === 0 ? { subscribe: {} } : {}),
      });
      for (const workspace of result.entries) {
        if (!removedWhileListing.has(workspace.id)) track(workspace.id);
      }
      cursor = result.pageInfo?.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
  })()
    .catch((error) => {
      console.warn("[agent-crew] Could not list workspaces for header buttons", error);
    })
    .finally(() => {
      listing = false;
      removedWhileListing.clear();
    });

  return () => {
    stopped = true;
    unsubscribe();
    for (const registration of buttons.values()) registration.remove();
    buttons.clear();
  };
}
