import type { PluginServerContext } from "@getpaseo/plugin/server";
import { acknowledgeViewerUpdates, resolveViewerScope } from "./server/viewer-scope";
import { acknowledgeViewerScope, viewerScope } from "./shared/viewer-scope";

export default function contribute(server: PluginServerContext) {
  server.handle(viewerScope, resolveViewerScope);
  server.handle(acknowledgeViewerScope, acknowledgeViewerUpdates);
  return () => {};
}
