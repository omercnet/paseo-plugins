import { afterEach, expect, it } from "vitest";
import { type BrowserRuntimeClient, SessionManager } from "../server/browser";
import type { JsonValue } from "../server/runtime-protocol";

interface Page {
  id: string;
  url: string;
  title: string;
}

class TabRuntimeClient implements BrowserRuntimeClient {
  readonly pages = new Map<string, Page>();
  private nextId = 1;

  async connect() {
    return { epoch: 1 };
  }

  async ensureWorkspace(workspaceId: string) {
    if (this.pages.size === 0) this.pages.set("page-one", this.page("page-one"));
    return { workspaceId, runtimeId: "runtime-one", createdAt: 1 };
  }

  async requestWorkspace(
    _workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (operation === "tabs.list") {
      return [...this.pages.values()].map(({ id, title, url }) => ({ targetId: id, title, url }));
    }
    if (operation === "tabs.create") {
      const id = `page-${++this.nextId}`;
      this.pages.set(id, this.page(id));
      return { targetId: id };
    }
    if (operation === "tabs.close") {
      if (this.pages.size <= 1) throw new Error("The last browser tab cannot be closed");
      this.pages.delete(String(data.targetId));
      return null;
    }
    const targetId = typeof data.targetId === "string" ? data.targetId : "page-one";
    const page = this.pages.get(targetId);
    if (!page) throw new Error("Browser tab is no longer available");
    if (operation === "identity") return { targetId, userAgent: "Fake Chromium" };
    if (operation === "state") {
      return {
        url: page.url,
        title: page.title,
        canGoBack: false,
        canGoForward: false,
        inputGeneration: "0:0",
      };
    }
    if (operation === "navigate") {
      page.url = String(data.url);
      return null;
    }
    if (["emulate", "screencast.stop", "video.stop"].includes(operation)) return null;
    throw new Error(`Unexpected tab operation: ${operation}`);
  }

  async archiveWorkspace() {
    this.pages.clear();
  }

  async closeWorkspace() {
    this.pages.clear();
  }

  disconnect() {}

  private page(id: string): Page {
    return { id, url: `https://${id}.example/`, title: id };
  }
}

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.disconnect();
});

function createManager() {
  let counter = 0;
  const client = new TabRuntimeClient();
  const manager = new SessionManager({
    client,
    validateWorkspace: async () => true,
    issueToken: () => `token_${String(++counter).padStart(40, "0")}`,
  });
  managers.push(manager);
  return { client, manager };
}

it("keeps selected pages, control and navigation independent for two viewers", async () => {
  const { manager } = createManager();
  const first = await manager.attach("workspace-one", "First viewer");
  const created = await manager.createTab(first.viewerToken);
  const second = await manager.attach("workspace-one", "Second viewer", created.tabId);
  const firstControl = await manager.acquireControl(first.viewerToken);
  const secondControl = await manager.acquireControl(second.viewerToken);

  expect(firstControl.state.controller).toBe("self");
  expect(secondControl.state.controller).toBe("self");
  expect(firstControl.state.tabId).not.toBe(secondControl.state.tabId);
  expect((await manager.listTabs("workspace-one")).tabs).toMatchObject([
    { id: "page-one", viewerCount: 1, controllerLabel: "First viewer" },
    { id: created.tabId, viewerCount: 1, controllerLabel: "Second viewer" },
  ]);

  await manager.navigate({
    viewerToken: first.viewerToken,
    controlToken: firstControl.controlToken,
    expected: firstControl.state,
    action: { kind: "goto", url: "https://first.example/" },
  });
  expect((await manager.status(first.viewerToken)).state.url).toBe("https://first.example/");
  expect((await manager.status(second.viewerToken)).state.url).toBe("https://page-2.example/");
  expect((await manager.status(second.viewerToken)).state.controller).toBe("self");
  await manager.detach(second.viewerToken);
  expect((await manager.listTabs("workspace-one")).tabs[1]).toMatchObject({
    viewerCount: 0,
    controllerLabel: null,
  });
});

it("requires an active viewer lease before listing tab titles and URLs", async () => {
  const { manager } = createManager();
  const first = await manager.attach("workspace-one", "First viewer");

  await expect(manager.listTabsForViewer("missing-viewer")).rejects.toThrow(
    "Viewer token is invalid or expired",
  );
  await expect(manager.listTabsForViewer(first.viewerToken)).resolves.toMatchObject({
    tabs: [{ id: "page-one" }],
  });

  await manager.detach(first.viewerToken);
  await expect(manager.listTabsForViewer(first.viewerToken)).rejects.toThrow(
    "Viewer token is invalid or expired",
  );
});

it("coalesces simultaneous first attachments to the same tab", async () => {
  const { client, manager } = createManager();
  let releaseIdentity!: () => void;
  let enteredIdentity!: () => void;
  const identityEntered = new Promise<void>((resolve) => {
    enteredIdentity = resolve;
  });
  const identityGate = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  const originalRequest = client.requestWorkspace.bind(client);
  client.requestWorkspace = async (workspaceId, operation, input) => {
    if (operation === "identity") {
      enteredIdentity();
      await identityGate;
    }
    return originalRequest(workspaceId, operation, input);
  };

  const first = manager.attach("workspace-one", "First viewer");
  await identityEntered;
  const second = manager.attach("workspace-one", "Second viewer", "page-one");
  releaseIdentity();
  const [firstViewer, secondViewer] = await Promise.all([first, second]);

  expect(secondViewer.state.sessionId).toBe(firstViewer.state.sessionId);
  expect((await manager.listTabsForViewer(firstViewer.viewerToken)).tabs).toMatchObject([
    { id: "page-one", viewerCount: 2 },
  ]);
});

it("closes one tab without ending another tab or the shared profile runtime", async () => {
  const { client, manager } = createManager();
  const first = await manager.attach("workspace-one", "First viewer");
  const created = await manager.createTab(first.viewerToken);
  const second = await manager.attach("workspace-one", "Second viewer", created.tabId);
  const control = await manager.acquireControl(second.viewerToken);

  await manager.closeTab({
    viewerToken: second.viewerToken,
    controlToken: control.controlToken,
    tabId: created.tabId,
  });
  await expect(manager.status(second.viewerToken)).rejects.toThrow("Browser tab is closed");
  expect((await manager.status(first.viewerToken)).state.tabId).toBe("page-one");
  expect(client.pages.has("page-one")).toBe(true);
  expect((await manager.listTabs("workspace-one")).tabs.map((tab) => tab.id)).toEqual(["page-one"]);
});

it("keeps the browser runtime when an explicit tab is no longer available", async () => {
  const { client, manager } = createManager();
  await expect(manager.attach("workspace-one", "Viewer", "missing-tab")).rejects.toThrow(
    "Browser tab is no longer available",
  );
  expect(client.pages.has("page-one")).toBe(true);
  await expect(manager.attach("workspace-one", "Viewer")).resolves.toMatchObject({
    state: { tabId: "page-one" },
  });
});

it("does not publish a late tab attachment after closing the whole browser", async () => {
  const { client, manager } = createManager();
  const first = await manager.attach("workspace-one", "First viewer");
  const control = await manager.acquireControl(first.viewerToken);
  const created = await manager.createTab(first.viewerToken);
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = client.requestWorkspace.bind(client);
  client.requestWorkspace = async (workspaceId, operation, input) => {
    const result = await original(workspaceId, operation, input);
    if (operation === "state" && (input as { targetId?: string })?.targetId === created.tabId) {
      entered();
      await gate;
    }
    return result;
  };

  const late = manager.attach("workspace-one", "Late viewer", created.tabId);
  await pending;
  await manager.closeBrowser({
    viewerToken: first.viewerToken,
    controlToken: control.controlToken,
    sessionId: first.state.sessionId,
    runtimeId: first.state.runtimeId!,
  });
  release();
  await expect(late).rejects.toThrow("Browser is closed");
  expect(await manager.listOpenWorkspaceIds()).toEqual([]);
});
