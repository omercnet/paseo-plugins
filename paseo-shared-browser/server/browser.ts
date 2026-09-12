import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
} from "../shared/browser";
import type { JsonValue } from "./runtime-protocol";
import { SupervisorClient } from "./supervisor-client";
import { resolveSupervisorPaths } from "./supervisor";

export { SessionManager, normalizeBrowserUrl } from "./browser-policy";
export type {
  BrowserRuntimeClient,
  SessionManagerOptions,
  WorkspaceValidator,
} from "./browser-policy";

type AttachInput = RpcInput<typeof attachBrowserRpc>;
type AttachOutput = RpcOutput<typeof attachBrowserRpc>;
type DetachInput = RpcInput<typeof detachBrowserRpc>;
type DetachOutput = RpcOutput<typeof detachBrowserRpc>;
type CaptureInput = RpcInput<typeof captureBrowserRpc>;
type CaptureOutput = RpcOutput<typeof captureBrowserRpc>;
type AcquireControlInput = RpcInput<typeof acquireControlRpc>;
type AcquireControlOutput = RpcOutput<typeof acquireControlRpc>;
type ReleaseControlInput = RpcInput<typeof releaseControlRpc>;
type ReleaseControlOutput = RpcOutput<typeof releaseControlRpc>;
type ListOpenOutput = RpcOutput<typeof listOpenBrowserWorkspacesRpc>;
type NavigateInput = RpcInput<typeof navigateBrowserRpc>;
type NavigateOutput = RpcOutput<typeof navigateBrowserRpc>;
type ResizeInput = RpcInput<typeof resizeBrowserRpc>;
type ResizeOutput = RpcOutput<typeof resizeBrowserRpc>;
type ApplyDevicePresetInput = RpcInput<typeof applyDevicePresetRpc>;
type ApplyDevicePresetOutput = RpcOutput<typeof applyDevicePresetRpc>;
type SendInput = RpcInput<typeof sendBrowserInputRpc>;
type SendOutput = RpcOutput<typeof sendBrowserInputRpc>;

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

class RemoteBrowserManager {
  constructor(private readonly client: SupervisorClient) {}

  async connect(): Promise<void> {
    await this.client.connect();
  }

  attach(workspaceId: string, viewerLabel: string): Promise<AttachOutput> {
    return this.client.requestBrowser<AttachOutput>("attach", { workspaceId, viewerLabel });
  }

  detach(viewerToken: string): Promise<DetachOutput> {
    return this.client.requestBrowser<DetachOutput>("detach", { viewerToken });
  }

  capture(
    viewerToken: string,
    quality: CaptureInput["quality"],
    knownFrameId: string | null,
  ): Promise<CaptureOutput> {
    return this.client.requestBrowser<CaptureOutput>("capture", {
      viewerToken,
      quality,
      knownFrameId,
    });
  }

  acquireControl(viewerToken: string, takeover: boolean): Promise<AcquireControlOutput> {
    return this.client.requestBrowser<AcquireControlOutput>("acquire-control", {
      viewerToken,
      takeover,
    });
  }

  releaseControl(viewerToken: string, controlToken: string): Promise<ReleaseControlOutput> {
    return this.client.requestBrowser<ReleaseControlOutput>("release-control", {
      viewerToken,
      controlToken,
    });
  }

  navigate(input: NavigateInput): Promise<NavigateOutput> {
    return this.client.requestBrowser<NavigateOutput>("navigate", input as unknown as JsonValue);
  }

  resize(input: ResizeInput): Promise<ResizeOutput> {
    return this.client.requestBrowser<ResizeOutput>("viewport", input as unknown as JsonValue);
  }

  applyDevicePreset(input: ApplyDevicePresetInput): Promise<ApplyDevicePresetOutput> {
    return this.client.requestBrowser<ApplyDevicePresetOutput>(
      "device",
      input as unknown as JsonValue,
    );
  }

  sendInput(input: SendInput): Promise<SendOutput> {
    return this.client.requestBrowser<SendOutput>("input", input as unknown as JsonValue);
  }

  async listOpenWorkspaceIds(): Promise<string[]> {
    const result = await this.client.requestBrowser("list", {});
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !("workspaceIds" in result)
    )
      throw new Error("Supervisor returned an invalid workspace list");
    const workspaceIds = result.workspaceIds;
    if (
      !Array.isArray(workspaceIds) ||
      !workspaceIds.every((value): value is string => typeof value === "string")
    )
      throw new Error("Supervisor returned an invalid workspace list");
    return workspaceIds;
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.client.requestBrowser("archive", { workspaceId });
  }

  issueAgentTicket(ticket: string): Promise<void> {
    return this.client.issueAgentTicket(ticket);
  }

  bindAgentTicket(ticket: string, agentId: string, workspaceId: string): Promise<void> {
    return this.client.bindAgentTicket(ticket, agentId, workspaceId);
  }

  revokeAgent(agentId: string): Promise<void> {
    return this.client.revokeAgent(agentId);
  }

  disconnect(): void {
    this.client.disconnect();
  }
}

let productionManager: RemoteBrowserManager | null = null;
let productionStart: Promise<RemoteBrowserManager> | null = null;
let productionStopped = false;

async function launchSupervisor(): Promise<void> {
  const supervisorPath = join(
    paseoHome(),
    "plugin-data",
    "shared-browser",
    "runtime",
    "supervisor.cjs",
  );
  try {
    await access(supervisorPath);
  } catch {
    throw new Error(`Shared Browser supervisor runtime is missing: ${supervisorPath}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [supervisorPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PASEO_HOME: paseoHome() },
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

async function getProductionManager(): Promise<RemoteBrowserManager> {
  if (productionStopped) throw new Error("Shared Browser plugin is stopping");
  if (productionManager) return productionManager;
  productionStart ??= (async () => {
    const manager = new RemoteBrowserManager(
      new SupervisorClient({ bridgeId: randomUUID(), paths: resolveSupervisorPaths(paseoHome()) }),
    );
    try {
      await manager.connect();
    } catch {
      await launchSupervisor();
      let lastError: unknown;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await manager.connect();
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    }
    if (productionStopped) {
      manager.disconnect();
      throw new Error("Shared Browser plugin is stopping");
    }
    productionManager = manager;
    return manager;
  })();
  try {
    return await productionStart;
  } finally {
    productionStart = null;
  }
}

export async function issueAgentTicket(ticket: string): Promise<void> {
  await (await getProductionManager()).issueAgentTicket(ticket);
}

export async function bindAgentTicket(
  ticket: string,
  agentId: string,
  workspaceId: string,
): Promise<void> {
  await (await getProductionManager()).bindAgentTicket(ticket, agentId, workspaceId);
}

export async function revokeAgentBrowserAccess(agentId: string): Promise<void> {
  await (await getProductionManager()).revokeAgent(agentId);
}

export async function handleAttachBrowser(
  input: AttachInput,
  context: PluginHandlerContext,
): Promise<AttachOutput> {
  const workspace = await context.paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace) throw new Error("Workspace not found");
  return (await getProductionManager()).attach(input.workspaceId, input.viewerLabel);
}

export async function handleDetachBrowser({ viewerToken }: DetachInput): Promise<DetachOutput> {
  return (await getProductionManager()).detach(viewerToken);
}

export async function handleWorkspaceArchived(workspaceId: string): Promise<void> {
  if (productionStopped) return;
  await (await getProductionManager()).archiveWorkspace(workspaceId);
}

export async function handleListOpenBrowserWorkspaces(): Promise<ListOpenOutput> {
  return { workspaceIds: await (await getProductionManager()).listOpenWorkspaceIds() };
}

export async function handleCaptureBrowser({
  viewerToken,
  quality,
  knownFrameId,
}: CaptureInput): Promise<CaptureOutput> {
  return (await getProductionManager()).capture(viewerToken, quality, knownFrameId);
}

export async function handleAcquireControl({
  viewerToken,
  takeover,
}: AcquireControlInput): Promise<AcquireControlOutput> {
  return (await getProductionManager()).acquireControl(viewerToken, takeover);
}

export async function handleReleaseControl({
  viewerToken,
  controlToken,
}: ReleaseControlInput): Promise<ReleaseControlOutput> {
  return (await getProductionManager()).releaseControl(viewerToken, controlToken);
}

export async function handleNavigateBrowser(input: NavigateInput): Promise<NavigateOutput> {
  return (await getProductionManager()).navigate(input);
}

export async function handleResizeBrowser(input: ResizeInput): Promise<ResizeOutput> {
  return (await getProductionManager()).resize(input);
}

export async function handleApplyDevicePreset(
  input: ApplyDevicePresetInput,
): Promise<ApplyDevicePresetOutput> {
  return (await getProductionManager()).applyDevicePreset(input);
}

export async function handleSendBrowserInput(input: SendInput): Promise<SendOutput> {
  return (await getProductionManager()).sendInput(input);
}

export async function cleanupBrowserServer(): Promise<void> {
  productionStopped = true;
  if (productionStart) await productionStart.catch(() => undefined);
  productionManager?.disconnect();
  productionManager = null;
}
