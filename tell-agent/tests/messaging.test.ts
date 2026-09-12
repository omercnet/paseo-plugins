import { describe, expect, test } from "bun:test";
import type { AgentEntry } from "../client/agents";
import {
  formatTellInstruction,
  messageTargets,
  parseTellArguments,
  resolveMessageTarget,
} from "../client/messaging";

type AgentOverrides = Partial<AgentEntry["agent"]>;
type ProjectOverrides = Partial<AgentEntry["project"]>;

function entry(agent: AgentOverrides = {}, project: ProjectOverrides = {}): AgentEntry {
  return {
    agent: {
      id: "agent-source",
      provider: "codex",
      cwd: "/work/source",
      workspaceId: "workspace-source",
      model: "gpt-5",
      createdAt: "2026-09-10T10:00:00.000Z",
      updatedAt: "2026-09-10T11:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {},
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Source agent",
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      ...agent,
    },
    project: {
      projectKey: "project-source",
      projectName: "Source project",
      workspaceName: "Source workspace",
      checkout: {
        cwd: "/work/source",
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

describe("cross-session target search", () => {
  const source = entry();
  const payments = entry(
    {
      id: "agent-payments",
      workspaceId: "workspace-payments",
      title: "Payments reviewer",
      updatedAt: "2026-09-10T12:00:00.000Z",
    },
    { projectName: "Backend", workspaceName: "Payments" },
  );
  const archived = entry({
    id: "agent-archived",
    title: "Payments archive",
    archivedAt: "2026-09-10T12:30:00.000Z",
  });
  const closed = entry({ id: "agent-closed", title: "Payments closed", status: "closed" });

  test("finds active agents in other workspaces and excludes the source", () => {
    expect(
      messageTargets([source, payments, archived, closed], source.agent.id, "payments"),
    ).toEqual([payments]);
  });

  test("resolves unique id prefixes and reports ambiguous workspace searches", () => {
    expect(resolveMessageTarget([source, payments], source.agent.id, "agent-pay")).toEqual({
      kind: "match",
      entry: payments,
    });
    const second = entry(
      { id: "agent-payments-2", workspaceId: "workspace-payments", title: "Payments tester" },
      { projectName: "Backend", workspaceName: "Payments" },
    );
    const ambiguous = resolveMessageTarget([source, payments, second], source.agent.id, "payments");
    expect(ambiguous.kind).toBe("ambiguous");
  });
});

describe("tell command", () => {
  test("requires an explicit target and message separator", () => {
    expect(parseTellArguments("Payments :: Review the auth change")).toEqual({
      target: "Payments",
      message: "Review the auth change",
    });
    expect(parseTellArguments("Payments Review the auth change")).toBeNull();
    expect(parseTellArguments("Payments ::   ")).toBeNull();
  });

  test("formats an instruction for the current agent", () => {
    expect(formatTellInstruction("agent-payments", "  Please review this.  ")).toBe(
      "tell agent-payments: Please review this.",
    );
  });
});
