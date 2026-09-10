import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cleanupBrowserServer,
  handleAcquireControl,
  handleApplyDevicePreset,
  handleAttachBrowser,
  handleCaptureBrowser,
  handleDetachBrowser,
  handleListOpenBrowserWorkspaces,
  handleNavigateBrowser,
  handleReleaseControl,
  handleResizeBrowser,
  handleSendBrowserInput,
  handleWorkspaceArchived,
} from "./server/browser";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  captureBrowserRpc,
  detachBrowserRpc,
  listOpenBrowserWorkspacesRpc,
  navigateBrowserRpc,
  releaseControlRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
} from "./shared/browser";

export default function contribute(server: PluginServerContext) {
  server.handle(attachBrowserRpc, handleAttachBrowser);
  server.handle(detachBrowserRpc, handleDetachBrowser);
  server.handle(captureBrowserRpc, handleCaptureBrowser);
  server.handle(listOpenBrowserWorkspacesRpc, handleListOpenBrowserWorkspaces);
  server.handle(acquireControlRpc, handleAcquireControl);
  server.handle(releaseControlRpc, handleReleaseControl);
  server.handle(navigateBrowserRpc, handleNavigateBrowser);
  server.handle(resizeBrowserRpc, handleResizeBrowser);
  server.handle(applyDevicePresetRpc, handleApplyDevicePreset);
  server.handle(sendBrowserInputRpc, handleSendBrowserInput);

  server.on("workspace.archived", async ({ workspace }) => {
    await handleWorkspaceArchived(workspace.id);
  });

  return async () => {
    await cleanupBrowserServer();
  };
}
