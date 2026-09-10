import { describe, expect, test } from "bun:test";
import { handleTellCommand } from "../client/tell-command";

type TellContext = Parameters<typeof handleTellCommand>[0];

describe("tell command keyboard flow", () => {
  test("opens the agent picker for a bare command without listing agents", async () => {
    const opened: string[] = [];
    let listed = false;
    const context = {
      args: "   ",
      agent: { id: "source-agent" },
      openPanel(id: string) {
        opened.push(id);
      },
      paseo: {
        agents: {
          async list() {
            listed = true;
            throw new Error("bare /tell must not query before opening the picker");
          },
        },
      },
    } as unknown as TellContext;

    await handleTellCommand(context);

    expect(opened).toEqual(["tell-agent"]);
    expect(listed).toBeFalse();
  });

  test("prompts the source session instead of sending verbatim to the target", async () => {
    const referencedAgents: string[] = [];
    const sentMessages: string[] = [];
    const target = {
      agent: {
        id: "target-agent",
        title: "Target agent",
        status: "running",
        archivedAt: null,
        updatedAt: "2026-09-10T12:00:00.000Z",
      },
      project: {
        projectName: "Other project",
        workspaceName: "Other workspace",
        checkout: { isGit: false },
      },
    };
    const context = {
      args: "target-agent :: review this change",
      agent: { id: "source-agent" },
      openPanel() {},
      paseo: {
        agents: {
          async list() {
            return {
              entries: [target],
              pageInfo: { hasMore: false, nextCursor: null },
            };
          },
          ref(agentId: string) {
            referencedAgents.push(agentId);
            return {
              async send(message: string) {
                sentMessages.push(message);
              },
            };
          },
        },
      },
    } as unknown as TellContext;

    await handleTellCommand(context);

    expect(referencedAgents).toEqual(["source-agent"]);
    expect(sentMessages).toEqual(["tell target-agent: review this change"]);
  });
});
