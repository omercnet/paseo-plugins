import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bindAgentTicket,
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
  issueAgentTicket,
  revokeAgentBrowserAccess,
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
  return join(paseoHome(), "plugin-data", "shared-browser", "runtime", "shared-browser-mcp.cjs");
}

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
  server.before("agent.create", async ({ request }) => {
    if (request.config.internal || request.config.provider === "omp") return request;
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
