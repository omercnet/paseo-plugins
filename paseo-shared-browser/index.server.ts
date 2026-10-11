import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  bindAgentTicket,
  cleanupBrowserServer,
  handleAcquireControl,
  handleApplyDevicePreset,
  handleAttachBrowser,
  handleBeginBrowserGesture,
  handleCaptureBrowser,
  handleCloseBrowser,
  handleCloseBrowserTab,
  handleCreateBrowserTab,
  handleDetachBrowser,
  handleEndBrowserGesture,
  handleListBrowserTabs,
  handleListOpenBrowserWorkspaces,
  handleNavigateBrowser,
  handleReadBrowserVideo,
  handleReleaseControl,
  handleReopenBrowser,
  handleResizeBrowser,
  handleSendBrowserInput,
  handleSetCaptureDensity,
  handleUpdateBrowserGesture,
  handleWorkspaceArchived,
  issueAgentTicket,
  revokeAgentBrowserAccess,
} from "./server/browser";
import { resolveBrowserRuntimeRoot } from "./server/runtime-path";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  closeBrowserTabRpc,
  createBrowserTabRpc,
  detachBrowserRpc,
  endBrowserGestureRpc,
  listBrowserTabsRpc,
  listOpenBrowserWorkspacesRpc,
  navigateBrowserRpc,
  releaseControlRpc,
  reopenBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "./shared/browser";
import { browserDisplayPreferences } from "./shared/browser-display-preferences";
import { readBrowserVideoRpc } from "./shared/browser-video";

const TICKET_ENV = "PASEO_SHARED_BROWSER_TICKET";
const MCP_SERVER_ID = "shared-browser";
const TICKET_ISSUE_TIMEOUT_MS = 2_000;

async function issueTicketWithinDeadline(ticket: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      issueAgentTicket(ticket),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Shared Browser ticket issuance timed out")),
          TICKET_ISSUE_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

function mcpBundlePath(): string {
  return join(resolveBrowserRuntimeRoot(paseoHome()), "shared-browser-mcp.cjs");
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(browserDisplayPreferences);
  server.handle(attachBrowserRpc, handleAttachBrowser);
  server.handle(detachBrowserRpc, handleDetachBrowser);
  server.handle(closeBrowserRpc, handleCloseBrowser);
  server.handle(closeBrowserTabRpc, handleCloseBrowserTab);
  server.handle(createBrowserTabRpc, handleCreateBrowserTab);
  server.handle(listBrowserTabsRpc, handleListBrowserTabs);
  server.handle(reopenBrowserRpc, handleReopenBrowser);
  server.handle(captureBrowserRpc, handleCaptureBrowser);
  server.handle(setCaptureDensityRpc, handleSetCaptureDensity);
  server.handle(readBrowserVideoRpc, handleReadBrowserVideo);
  server.handle(listOpenBrowserWorkspacesRpc, handleListOpenBrowserWorkspaces);
  server.handle(acquireControlRpc, handleAcquireControl);
  server.handle(releaseControlRpc, handleReleaseControl);
  server.handle(beginBrowserGestureRpc, handleBeginBrowserGesture);
  server.handle(updateBrowserGestureRpc, handleUpdateBrowserGesture);
  server.handle(endBrowserGestureRpc, handleEndBrowserGesture);
  server.handle(navigateBrowserRpc, handleNavigateBrowser);
  server.handle(resizeBrowserRpc, handleResizeBrowser);
  server.handle(applyDevicePresetRpc, handleApplyDevicePreset);
  server.handle(sendBrowserInputRpc, handleSendBrowserInput);
  // OMP accepts session MCP servers from Paseo 0.11.0-beta.1, the release that added
  // registerUsageSource; 0.9/0.10 reject agent creation when an OMP config carries MCP servers.
  const ompAcceptsMcp = typeof server.registerUsageSource === "function";
  server.before("agent.create", async ({ request }) => {
    if (request.config.internal) return request;
    if (request.config.provider === "omp" && !ompAcceptsMcp) return request;
    const ticket = randomBytes(32).toString("base64url");
    if (!(await issueTicketWithinDeadline(ticket))) return request;
    return {
      ...request,
      env: { ...request.env, [TICKET_ENV]: ticket },
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [MCP_SERVER_ID]: {
            type: "stdio",
            command: process.execPath,
            args: [mcpBundlePath()],
            env: {
              PASEO_HOME: paseoHome(),
              [TICKET_ENV]: ticket,
              ELECTRON_RUN_AS_NODE: "1",
            },
          },
        },
      },
    };
  });

  server.before("agent.session_open", async ({ request }) => {
    if (request.reason !== "create") return request;
    const ticket = request.env[TICKET_ENV];
    if (!ticket || request.purpose !== "interactive" || !request.workspaceId) return request;
    await bindAgentTicket(ticket, request.agentId, request.workspaceId);
    const { [TICKET_ENV]: _ticket, ...environment } = request.env;
    return { ...request, env: environment };
  });

  server.on("agent.archived", ({ agent }) => revokeAgentBrowserAccess(agent.id));

  server.on("workspace.archived", ({ workspace }) => handleWorkspaceArchived(workspace.id));

  return cleanupBrowserServer;
}
