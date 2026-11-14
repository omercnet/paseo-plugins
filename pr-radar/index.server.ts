import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  acknowledgeViewerUpdates,
  resolveViewerScope,
  startBackgroundRefresh,
} from "./server/viewer-scope";
import {
  listLocalDirsHandler,
  prepareWorkspaceCwdHandler,
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
  server.registerSettings(prRadarSettings);
  server.handle(viewerScope, resolveViewerScope);
  server.handle(acknowledgeViewerScope, acknowledgeViewerUpdates);
  server.handle(listLocalDirs, listLocalDirsHandler);
  server.handle(prepareWorkspaceCwd, prepareWorkspaceCwdHandler);
  server.handle(runRoutingScript, runRoutingScriptHandler);
  // Keep GitHub data warm so opening the radar never waits on gh.
  const stop = startBackgroundRefresh();
  return () => stop();
}
