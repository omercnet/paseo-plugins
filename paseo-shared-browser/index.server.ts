import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PluginHookContext,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
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
  handleGetBrowserVideoSettings,
  handleKeepAliveBrowserGesture,
  handleListBrowserTabs,
  handleListOpenBrowserWorkspaces,
  handleNavigateBrowser,
  handleReadBrowserVideo,
  handleReleaseControl,
  handleReopenBrowser,
  handleResizeBrowser,
  handleSendBrowserInput,
  handleSetBrowserVideoSettings,
  handleSetCaptureDensity,
  handleUpdateBrowserGesture,
  handleWorkspaceArchived,
  issueAgentTicket,
  revokeAgentBrowserAccess,
} from "./server/browser";
import { resolveBrowserRuntimeRoot } from "./server/runtime-path";
import { listAllWorkspaces } from "./server/workspace-list";
import {
  accessFromState,
  agentAccessSettings,
  agentGetsBrowser,
  agentGetsBrowserByLabel,
  DEFAULT_AGENT_ACCESS,
} from "./shared/agent-access";
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
  getBrowserVideoSettingsRpc,
  keepAliveBrowserGestureRpc,
  listBrowserTabsRpc,
  listOpenBrowserWorkspacesRpc,
  navigateBrowserRpc,
  releaseControlRpc,
  reopenBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  setBrowserVideoSettingsRpc,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "./shared/browser";
import { browserDisplayPreferences } from "./shared/browser-display-preferences";
import { readBrowserVideoRpc } from "./shared/browser-video";

const TICKET_ENV = "PASEO_SHARED_BROWSER_TICKET";
const MCP_SERVER_ID = "shared-browser";
const TICKET_ISSUE_TIMEOUT_MS = 2_000;
const ACCESS_DECISION_TIMEOUT_MS = 2_000;

/** The result of `work`, or a rejection when it has not settled within `ms`. */
async function withinDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function issueTicketWithinDeadline(ticket: string): Promise<boolean> {
  try {
    await withinDeadline(
      issueAgentTicket(ticket),
      TICKET_ISSUE_TIMEOUT_MS,
      "Shared Browser ticket issuance timed out",
    );
    return true;
  } catch {
    return false;
  }
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

function mcpBundlePath(): string {
  return join(resolveBrowserRuntimeRoot(paseoHome()), "shared-browser-mcp.cjs");
}

/** Fields of the session-open request that only newer Paseo releases send. */
interface OptionalOpenFields {
  labels?: Readonly<Record<string, string>>;
  background?: boolean;
  mcpServers?: Record<string, unknown>;
}

/** The stdio server entry that runs the browser adapter for one ticket. */
function browserMcpServer(ticket: string) {
  return {
    type: "stdio" as const,
    command: process.execPath,
    args: [mcpBundlePath()],
    env: { PASEO_HOME: paseoHome(), [TICKET_ENV]: ticket, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(browserDisplayPreferences);
  const agentAccess = server.registerSettings(agentAccessSettings);
  // The deadline covers the settings read alone: a setting that cannot be read in time is an unreadable
  // setting, and that falls back to the default (every new agent).
  // `quiet` is for the session-open path, which runs on every open: the fallback is still taken, without a log line each time.
  const readAccess = async (quiet = false) => {
    try {
      const state = await withinDeadline(
        Promise.resolve(agentAccess.read()),
        ACCESS_DECISION_TIMEOUT_MS,
        "the read timed out",
      );
      const access = accessFromState(state);
      if (access === DEFAULT_AGENT_ACCESS && !quiet) {
        console.warn(
          `shared-browser: the agent-access setting is ${state?.status ?? "missing"}; every new agent gets the browser tool`,
        );
      }
      return access;
    } catch (error) {
      if (!quiet) {
        console.warn(
          `shared-browser: the agent-access setting could not be read (${error instanceof Error ? error.message : "error"}); every new agent gets the browser tool`,
        );
      }
      return DEFAULT_AGENT_ACCESS;
    }
  };
  // The workspace lookup has its own deadline; a timeout or any other failure there is no match.
  const lookupWorkspaces = async (paseo: PluginHookContext["paseo"]) => {
    try {
      return await withinDeadline(
        listAllWorkspaces(paseo),
        ACCESS_DECISION_TIMEOUT_MS,
        "the workspace lookup timed out",
      );
    } catch (error) {
      console.warn(
        `shared-browser: the workspace lookup failed (${error instanceof Error ? error.message : "error"}); the agent is not matched to a workspace or project`,
      );
      throw error;
    }
  };
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
  server.handle(keepAliveBrowserGestureRpc, handleKeepAliveBrowserGesture);
  server.handle(getBrowserVideoSettingsRpc, handleGetBrowserVideoSettings);
  server.handle(setBrowserVideoSettingsRpc, handleSetBrowserVideoSettings);
  server.handle(navigateBrowserRpc, handleNavigateBrowser);
  server.handle(resizeBrowserRpc, handleResizeBrowser);
  server.handle(applyDevicePresetRpc, handleApplyDevicePreset);
  server.handle(sendBrowserInputRpc, handleSendBrowserInput);
  server.before("agent.create", async ({ request }, context) => {
    if (request.config.internal) return request;
    // Decide before any ticket or supervisor work, so an agent that is not allowed costs nothing.
    const allowed = await agentGetsBrowser(await readAccess(), request.config, () =>
      lookupWorkspaces(context.paseo),
    );
    if (!allowed) return request;
    const ticket = randomBytes(32).toString("base64url");
    if (!(await issueTicketWithinDeadline(ticket))) return request;
    return {
      ...request,
      env: { ...request.env, [TICKET_ENV]: ticket },
      config: {
        ...request.config,
        mcpServers: { ...request.config.mcpServers, [MCP_SERVER_ID]: browserMcpServer(ticket) },
      },
    };
  });

  server.before("agent.session_open", async ({ request }) => {
    const ticket = request.env[TICKET_ENV];
    if (request.reason === "create" && ticket) {
      if (request.purpose !== "interactive" || !request.workspaceId) return request;
      await bindAgentTicket(ticket, request.agentId, request.workspaceId);
      const { [TICKET_ENV]: _ticket, ...environment } = request.env;
      return { ...request, env: environment };
    }
    // The env ticket is the only signal that the create hook already stored the server on this agent: the host sends
    // mcpServers as {} to out-of-process plugins, so that field says nothing about what is stored.
    if (ticket) return request;
    return injectByLabel(request);
  });

  // Labels are on the session-open request but not on agent.create, so an agent chosen by label is handled here, in every
  // interactive session of an agent that carries a matching label: a server returned from this hook lasts for that session
  // only (unlike one added in agent.create, which is stored on the agent), so each open issues and binds a fresh ticket.
  // Agents that gave no label, helpers, and sessions without a workspace are returned at once. Nothing here throws: a
  // failure leaves the session without the tool instead of failing it.
  const injectByLabel = async (request: PluginSessionOpenRequest) => {
    // Older Paseo releases (0.13) do not send labels, a background flag or MCP servers on this request, so this does nothing there.
    const { labels, background, mcpServers } = request as PluginSessionOpenRequest &
      OptionalOpenFields;
    if (request.purpose !== "interactive" || background === true || !request.workspaceId)
      return request;
    if (!labels || Object.keys(labels).length === 0) return request;
    if (!agentGetsBrowserByLabel(await readAccess(true), labels)) return request;
    const ticket = randomBytes(32).toString("base64url");
    if (!(await issueTicketWithinDeadline(ticket))) {
      console.warn(
        "shared-browser: could not issue a browser ticket for a labelled agent; the session opens without it",
      );
      return request;
    }
    try {
      await withinDeadline(
        bindAgentTicket(ticket, request.agentId, request.workspaceId),
        TICKET_ISSUE_TIMEOUT_MS,
        "Shared Browser ticket binding timed out",
      );
    } catch (error) {
      console.warn(
        `shared-browser: could not bind the browser ticket for a labelled agent (${error instanceof Error ? error.message : "error"}); the session opens without it`,
      );
      return request;
    }
    return {
      ...request,
      mcpServers: { ...mcpServers, [MCP_SERVER_ID]: browserMcpServer(ticket) },
    } as PluginSessionOpenRequest;
  };

  server.on("agent.archived", ({ agent }) => revokeAgentBrowserAccess(agent.id));

  server.on("workspace.archived", ({ workspace }) => handleWorkspaceArchived(workspace.id));

  return cleanupBrowserServer;
}
