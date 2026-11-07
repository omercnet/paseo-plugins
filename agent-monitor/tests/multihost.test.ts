import { describe, expect, test } from "vitest";
import type { InteractionData } from "../client/graph";
import { buildClusterBoxes, buildGraph, NODE_HEIGHT, NODE_WIDTH } from "../client/graph";
import { mergeHostInteractions } from "../client/graph-data";
import {
  type AgentEntry,
  baseProjectName,
  buildRoster,
  type GroupOptions,
  groupByProject,
  HOST_PALETTE,
  type HostScope,
  hostColor,
  hostOf,
  indexProjects,
  type MonitorDirectory,
  matches,
  mergeProjectGroupsAcrossHosts,
  type WorkspaceSummary,
  withHostScope,
} from "../client/monitor";
import { mergeHostDirectories } from "../client/monitor-data";

const HOST_BETA: HostScope = { serverId: "srv-beta", label: "beta" };
const HOST_ALPHA: HostScope = { serverId: "srv-alpha", label: "alpha" };
const OPTIONS: GroupOptions = { floatPinned: false, agentSort: "title", hostId: "srv-alpha" };

type AgentOverrides = Partial<AgentEntry["agent"]>;
type ProjectOverrides = Partial<AgentEntry["project"]>;

function entry(agent: AgentOverrides = {}, project: ProjectOverrides = {}): AgentEntry {
  return {
    agent: {
      id: "agent-123456",
      provider: "codex",
      cwd: "/work/project",
      workspaceId: "workspace-1",
      model: "gpt-5",
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T11:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {},
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Agent title",
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      ...agent,
    },
    project: {
      projectKey: "project-1",
      projectName: "Project",
      workspaceName: "Workspace",
      checkout: {
        cwd: "/work/project",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
      ...project,
    },
  } as AgentEntry;
}

function workspace(id: string, name: string, projectId: string): WorkspaceSummary {
  return {
    id,
    navigationId: id,
    name,
    projectId,
    projectName: name,
    pinned: false,
    labels: [],
    additions: 0,
    deletions: 0,
  };
}

function interactions(overrides: Partial<InteractionData> = {}): InteractionData {
  return {
    messagesByAgent: new Map(),
    edges: [],
    subagents: [],
    ...overrides,
  };
}

describe("cross-host roster order", () => {
  test("compact triage sorts across hosts and resolves children on their own host", () => {
    const idleAlpha = withHostScope(entry({ id: "a-idle", title: "a idle" }), HOST_ALPHA);
    const parentBeta = withHostScope(entry({ id: "b-parent", title: "b parent" }), HOST_BETA);
    const childBeta = withHostScope(
      entry({
        id: "b-child",
        title: "a child",
        labels: { "paseo.parent-agent-id": "b-parent", "paseo.parent-server-id": "srv-beta" },
      }),
      HOST_BETA,
    );
    const attentionBeta = withHostScope(
      entry({ id: "b-attention", title: "z attention", requiresAttention: true }),
      HOST_BETA,
    );
    const roster = buildRoster(
      [idleAlpha, childBeta, parentBeta, attentionBeta],
      { workspaces: new Map(), projects: new Map() },
      { grouping: "compact", floatPinned: false, agentSort: "triage" },
      HOST_ALPHA.serverId,
    );

    expect(roster.kind === "compact" && roster.entries.map((item) => item.agent.id)).toEqual([
      "b-attention",
      "a-idle",
      "b-parent",
      "b-child",
    ]);
  });
});

describe("host scope", () => {
  test("tags entries and reads the scope back", () => {
    expect(hostOf(entry())).toBeNull();
    const scoped = withHostScope(entry(), HOST_BETA);
    expect(hostOf(scoped)).toEqual(HOST_BETA);
  });

  test("search matches the host label", () => {
    expect(matches(withHostScope(entry(), HOST_BETA), "beta")).toBe(true);
    expect(matches(withHostScope(entry(), HOST_BETA), "alpha")).toBe(false);
  });
});

describe("attention quick access", () => {
  test("carries host and provider detail for the popover", async () => {
    const { attentionItems } = await import("../client/monitor");
    const items = attentionItems([
      withHostScope(
        entry({ id: "a", requiresAttention: true, provider: "claude", model: "opus" }),
        HOST_BETA,
      ),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].host?.label).toBe("beta");
    expect(items[0].detail).toBe("claude · opus");
  });
});

describe("layout panels", () => {
  test("initial cluster panels never overlap, however many hosts share a project", () => {
    const projects = ["ACME", "beacon", "CASTOR", "drift", "ember", "flux", "GRAIN"];
    const scoped = projects.flatMap((project) =>
      [HOST_ALPHA, HOST_BETA].map((host, hostIndex) =>
        withHostScope(
          entry(
            { id: `${project}-${hostIndex}`, workspaceId: `ws-${project}-${hostIndex}` },
            { projectKey: project.toLowerCase(), projectName: project, workspaceName: "general" },
          ),
          host,
        ),
      ),
    );
    // A couple of crowded panels, with several crowded panels.
    for (let i = 0; i < 6; i += 1) {
      scoped.push(
        withHostScope(
          entry(
            { id: `castor-extra-${i}`, workspaceId: `ws-castor-extra-${i}` },
            { projectKey: "castor", projectName: "CASTOR", workspaceName: "general" },
          ),
          HOST_BETA,
        ),
      );
    }
    const layout = buildGraph(
      scoped,
      { messagesByAgent: new Map(), edges: [], subagents: [] },
      "srv-switch",
    );
    for (const [aIndex, a] of layout.clusters.entries()) {
      for (const b of layout.clusters.slice(aIndex + 1)) {
        const separated =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(separated, `${a.key} overlaps ${b.key}`).toBe(true);
      }
    }
  });

  test("a multi-row panel box wraps every card in it", () => {
    const crowded = Array.from({ length: 6 }, (_, index) =>
      withHostScope(
        entry(
          { id: `castor-${index}`, workspaceId: `ws-castor-${index}` },
          { projectKey: "castor", projectName: "CASTOR", workspaceName: "general" },
        ),
        HOST_BETA,
      ),
    );
    const layout = buildGraph(
      crowded,
      { messagesByAgent: new Map(), edges: [], subagents: [] },
      "srv-switch",
    );
    const boxes = buildClusterBoxes(layout.nodes);
    expect(boxes).toHaveLength(1);
    const [box] = boxes;
    if (!box) throw new Error("expected one cluster box");
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(box.x);
      expect(node.y).toBeGreaterThanOrEqual(box.y);
      expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(box.x + box.width);
      expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  test("cluster boxes do not overlap in the initial layout", () => {
    const projects = ["ACME", "beacon", "CASTOR", "drift", "ember", "flux", "GRAIN"];
    const scoped = projects.flatMap((project) =>
      Array.from({ length: project === "CASTOR" ? 7 : 1 }, (_, index) =>
        withHostScope(
          entry(
            { id: `${project}-${index}`, workspaceId: `ws-${project}-${index}` },
            { projectKey: project.toLowerCase(), projectName: project, workspaceName: "general" },
          ),
          HOST_BETA,
        ),
      ),
    );
    const layout = buildGraph(
      scoped,
      { messagesByAgent: new Map(), edges: [], subagents: [] },
      "srv-switch",
    );
    const boxes = buildClusterBoxes(layout.nodes);
    for (const [index, left] of boxes.entries()) {
      for (const right of boxes.slice(index + 1)) {
        const separated =
          left.x + left.width <= right.x ||
          right.x + right.width <= left.x ||
          left.y + left.height <= right.y ||
          right.y + right.height <= left.y;
        expect(separated, `${left.key} overlaps ${right.key}`).toBe(true);
      }
    }
  });
});

describe("focus request", () => {
  test("peek keeps the request, take consumes it", async () => {
    const { peekAgentFocus, requestAgentFocus, takeAgentFocus } = await import(
      "../client/focus-request"
    );
    requestAgentFocus("agent-1");
    expect(peekAgentFocus()).toBe("agent-1");
    expect(peekAgentFocus()).toBe("agent-1");
    expect(takeAgentFocus()).toBe("agent-1");
    expect(peekAgentFocus()).toBeNull();
  });

  test("deep focus skips a pending agent that is not in the roster", async () => {
    const { resolveDeepFocus } = await import("../client/focus-request");
    expect(resolveDeepFocus("gone", "a1", ["a1"])).toBe("a1");
    expect(resolveDeepFocus("p1", "a1", ["a1", "p1"])).toBe("p1");
    expect(resolveDeepFocus("gone", "missing", ["a1"])).toBeNull();
    expect(resolveDeepFocus(null, undefined, ["a1"])).toBeNull();
  });

  test("agent open keeps the target host and is consumed once", async () => {
    const { peekAgentOpen, requestAgentOpen, takeAgentOpen } = await import(
      "../client/focus-request"
    );
    requestAgentOpen({ agentId: "agent-1", serverId: "srv-1", token: "t-1" });
    expect(peekAgentOpen()).toEqual({ agentId: "agent-1", serverId: "srv-1", token: "t-1" });
    expect(takeAgentOpen()).toEqual({ agentId: "agent-1", serverId: "srv-1", token: "t-1" });
    expect(takeAgentOpen()).toBeNull();
  });

  test("cycling steps through targets with wrapping", async () => {
    const { setCycleList, stepCycle } = await import("../client/focus-request");
    expect(stepCycle(1)).toBeNull();
    setCycleList([
      { agentId: "a", serverId: "srv-1" },
      { agentId: "b", serverId: "srv-2" },
    ]);
    expect(stepCycle(1)).toEqual({ agentId: "a", serverId: "srv-1" });
    expect(stepCycle(1)).toEqual({ agentId: "b", serverId: "srv-2" });
    expect(stepCycle(1)).toEqual({ agentId: "a", serverId: "srv-1" });
    expect(stepCycle(-1)).toEqual({ agentId: "b", serverId: "srv-2" });
    setCycleList([]);
    expect(stepCycle(1)).toBeNull();

    setCycleList([{ agentId: "x" }, { agentId: "y" }, { agentId: "z" }]);
    expect(stepCycle(-1)).toEqual({ agentId: "z" });
  });
});

describe("hostColor", () => {
  test("is stable per server and comes from the shared palette", () => {
    expect(hostColor(HOST_BETA)).toBe(hostColor(HOST_BETA));
    expect(HOST_PALETTE).toContain(hostColor(HOST_BETA));
    expect(HOST_PALETTE).toContain(hostColor(HOST_ALPHA));
  });
});

describe("baseProjectName", () => {
  test("strips a per-host suffix", () => {
    expect(baseProjectName("ACME · alpha")).toBe("ACME");
  });

  test("keeps plain names", () => {
    expect(baseProjectName("infra")).toBe("infra");
  });
});

describe("mergeHostDirectories", () => {
  test("tags entries per host and merges directories", () => {
    const alphaEntry = entry({ id: "alpha-1", workspaceId: "ws-alpha" });
    const deskEntry = entry({ id: "beta-1", workspaceId: "ws-beta" });
    const merged = mergeHostDirectories([
      {
        host: HOST_ALPHA,
        data: {
          entries: [alphaEntry],
          directory: {
            workspaces: new Map([["ws-alpha", workspace("ws-alpha", "general", "prj-alpha")]]),
            projects: indexProjects([]),
          },
          truncated: false,
        },
      },
      {
        host: HOST_BETA,
        data: {
          entries: [deskEntry],
          directory: {
            workspaces: new Map([["ws-beta", workspace("ws-beta", "general", "prj-beta")]]),
            projects: indexProjects([]),
          },
          truncated: true,
        },
      },
    ]);

    expect(merged.entries.map((item) => item.agent.id)).toEqual(["alpha-1", "beta-1"]);
    expect(hostOf(merged.entries[0])?.serverId).toBe(HOST_ALPHA.serverId);
    expect(hostOf(merged.entries[1])?.serverId).toBe(HOST_BETA.serverId);
    expect([...merged.directory.workspaces.keys()].sort()).toEqual(["ws-alpha", "ws-beta"]);
    expect(merged.truncated).toBe(true);
  });

  test("an unlisted workspace resolves the project on its own host when keys repeat", () => {
    // Same repo key on both hosts, different daemon-scoped projects; neither workspace is listed.
    const host = (scope: HostScope, projectId: string, name: string) => ({
      host: scope,
      data: {
        entries: [
          entry(
            { id: `${scope.label}-1`, workspaceId: undefined },
            { projectKey: "repo", projectName: "x" },
          ),
        ],
        directory: {
          workspaces: new Map(),
          projects: indexProjects([{ id: projectId, key: "repo", name }]),
        },
        truncated: false,
      },
    });
    const merged = mergeHostDirectories([
      host(HOST_ALPHA, "prj-alpha", "Alpha name"),
      host(HOST_BETA, "prj-beta", "Beta name"),
    ]);
    // Alpha merges first, so a shared index would hand alpha's agent beta's project.
    const alpha = merged.entries.filter((item) => hostOf(item)?.serverId === HOST_ALPHA.serverId);
    const projects = groupByProject(alpha, merged.directory, OPTIONS);

    expect(projects.map((project) => [project.id, project.name])).toEqual([
      ["prj-alpha", "Alpha name"],
    ]);
  });
});

describe("mergeHostInteractions", () => {
  test("concatenates edges and sums message counts", () => {
    const merged = mergeHostInteractions([
      interactions({
        messagesByAgent: new Map([["a", 2]]),
        edges: [{ from: "a", to: "b", count: 1, kind: "tree" }],
        subagents: [{ parentId: "a", id: "sub:a:x", label: "x", kind: "task", count: 1 }],
        unreadable: 1,
      }),
      interactions({
        messagesByAgent: new Map([["a", 3]]),
        edges: [{ from: "c", to: "d", count: 1, kind: "message" }],
        unreadable: 0,
      }),
    ]);

    expect(merged.messagesByAgent.get("a")).toBe(5);
    expect(merged.edges).toHaveLength(2);
    expect(merged.subagents).toHaveLength(1);
    expect(merged.unreadable).toBe(1);
  });
});

describe("mergeProjectGroupsAcrossHosts", () => {
  function directoryFor(projectId: string, projectName: string): MonitorDirectory {
    return {
      workspaces: new Map(),
      projects: indexProjects([{ id: projectId, name: projectName }]),
    };
  }

  test("merges a renamed project with its base name", () => {
    const alphaEntries = [
      withHostScope(
        entry(
          { id: "alpha-1", workspaceId: "ws-alpha" },
          { projectKey: "acme", projectName: "ACME · alpha", workspaceName: "general" },
        ),
        HOST_ALPHA,
      ),
    ];
    const betaEntries = [
      withHostScope(
        entry(
          { id: "beta-1", workspaceId: "ws-beta" },
          { projectKey: "acme", projectName: "ACME", workspaceName: "general" },
        ),
        HOST_BETA,
      ),
    ];
    const merged = mergeProjectGroupsAcrossHosts(
      [
        {
          host: HOST_ALPHA,
          projects: groupByProject(
            alphaEntries,
            directoryFor("prj-alpha", "ACME · alpha"),
            OPTIONS,
          ),
        },
        {
          host: HOST_BETA,
          projects: groupByProject(betaEntries, directoryFor("prj-beta", "ACME"), OPTIONS),
        },
      ],
      OPTIONS,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("ACME");
    expect(
      merged[0].workspaces.flatMap((group) => group.entries.map((item) => item.agent.id)).sort(),
    ).toEqual(["alpha-1", "beta-1"]);
  });

  test("keeps distinct projects apart and sorts by name", () => {
    const merged = mergeProjectGroupsAcrossHosts(
      [
        {
          host: HOST_ALPHA,
          projects: groupByProject(
            [entry({ id: "m1", workspaceId: "ws-infra" }, { projectName: "infra" })],
            {
              workspaces: new Map([["ws-infra", workspace("ws-infra", "infra", "prj-infra")]]),
              projects: indexProjects([{ id: "prj-infra", name: "infra" }]),
            },
            OPTIONS,
          ),
        },
        {
          host: HOST_BETA,
          projects: groupByProject(
            [entry({ id: "d1", workspaceId: "ws-intel" }, { projectName: "intel" })],
            {
              workspaces: new Map([["ws-intel", workspace("ws-intel", "intel", "prj-intel")]]),
              projects: indexProjects([{ id: "prj-intel", name: "intel" }]),
            },
            OPTIONS,
          ),
        },
      ],
      OPTIONS,
    );

    expect(merged.map((project) => project.name)).toEqual(["infra", "intel"]);
  });

  test("keeps same-name projects on one host apart under their own ids", () => {
    const merged = mergeProjectGroupsAcrossHosts(
      [
        {
          host: HOST_ALPHA,
          projects: groupByProject(
            [
              entry({ id: "w1", workspaceId: "ws-1" }, { projectName: "web" }),
              entry({ id: "w2", workspaceId: "ws-2" }, { projectName: "web" }),
            ],
            {
              workspaces: new Map([
                ["ws-1", workspace("ws-1", "web", "prj-1")],
                ["ws-2", workspace("ws-2", "web", "prj-2")],
              ]),
              projects: indexProjects([
                { id: "prj-1", name: "web" },
                { id: "prj-2", name: "web" },
              ]),
            },
            OPTIONS,
          ),
        },
      ],
      OPTIONS,
    );

    expect(merged.map((project) => project.id).sort()).toEqual(["prj-1", "prj-2"]);
  });

  test("orders merged projects by the user's sort, floating pinned ones first", () => {
    const pinnedOptions: GroupOptions = { ...OPTIONS, floatPinned: true };
    const merged = mergeProjectGroupsAcrossHosts(
      [
        {
          host: HOST_ALPHA,
          projects: groupByProject(
            [entry({ id: "m1", workspaceId: "ws-infra" }, { projectName: "infra" })],
            {
              workspaces: new Map([["ws-infra", workspace("ws-infra", "infra", "prj-infra")]]),
              projects: indexProjects([{ id: "prj-infra", name: "infra" }]),
            },
            pinnedOptions,
          ),
        },
        {
          host: HOST_BETA,
          projects: groupByProject(
            [entry({ id: "d1", workspaceId: "ws-intel" }, { projectName: "intel" })],
            {
              workspaces: new Map([
                ["ws-intel", { ...workspace("ws-intel", "intel", "prj-intel"), pinned: true }],
              ]),
              projects: indexProjects([{ id: "prj-intel", name: "intel" }]),
            },
            { ...pinnedOptions, hostId: HOST_BETA.serverId },
          ),
        },
      ],
      pinnedOptions,
    );

    expect(merged.map((project) => project.name)).toEqual(["intel", "infra"]);
  });
});

describe("multi-host graph", () => {
  test("shares one panel per project and records each node's host", () => {
    const layout = buildGraph(
      [
        withHostScope(
          entry({ id: "alpha-1" }, { projectName: "ACME · alpha", workspaceName: "general" }),
          HOST_ALPHA,
        ),
        withHostScope(
          entry({ id: "beta-1" }, { projectName: "ACME", workspaceName: "general" }),
          HOST_BETA,
        ),
      ],
      interactions(),
      "srv-switch",
    );

    expect(layout.nodes).toHaveLength(2);
    expect(new Set(layout.nodes.map((node) => node.colorKey)).size).toBe(1);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0].name).toBe("ACME / general");
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(byId.get("alpha-1")?.host?.label).toBe("alpha");
    expect(byId.get("beta-1")?.host?.label).toBe("beta");
  });
});
