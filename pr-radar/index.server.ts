import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  acknowledgeViewerUpdates,
  resolveViewerScope,
  startBackgroundRefresh,
} from "./server/viewer-scope";
import {
  listLocalDirsHandler,
  prepareWorkspaceCwdHandler,
  type ReadWorkspaceSettings,
  runRoutingScriptHandler,
} from "./server/workspace-ops";
import { prRadarSettings } from "./shared/settings";
import {
  acknowledgeViewerScope,
  listLocalDirs,
  prepareWorkspaceCwd,
  runRoutingScript,
  viewerScope,
} from "./shared/viewer-scope";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(prRadarSettings);
  // Directories and the routing script come from these registered settings, never from RPC input.
  const readSettings: ReadWorkspaceSettings = async () => {
    const state = await settings.read();
    if (state.status !== "ready") {
      throw new Error(`PR Radar settings are invalid: ${state.error}`);
    }
    return state.values;
  };
  server.handle(viewerScope, resolveViewerScope);
  server.handle(acknowledgeViewerScope, acknowledgeViewerUpdates);
  server.handle(listLocalDirs, (input) => listLocalDirsHandler(input, readSettings));
  server.handle(prepareWorkspaceCwd, (input) => prepareWorkspaceCwdHandler(input, readSettings));
  server.handle(runRoutingScript, (input) => runRoutingScriptHandler(input, readSettings));
  // Keep GitHub data warm so opening the radar never waits on gh.
  const stop = startBackgroundRefresh();
  return () => stop();
}
