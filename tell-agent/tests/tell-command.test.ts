import { describe, expect, test } from "vitest";
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
    expect(listed).toBe(false);
  });

  test.each([
    ["target-agent :: review this change", "steer"],
    ["--interrupt target-agent :: review this change", "interrupt"],
  ])("prompts the source session for %j with %s", async (args, activeTurnBehavior) => {
    const referencedAgents: string[] = [];
    const sentMessages: string[] = [];
    const sentOptions: unknown[] = [];
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
      args,
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
              async send(message: string, options?: unknown) {
                sentMessages.push(message);
                sentOptions.push(options);
              },
            };
          },
        },
      },
    } as unknown as TellContext;

    await handleTellCommand(context);

    expect(referencedAgents).toEqual(["source-agent"]);
    expect(sentMessages).toEqual(["tell target-agent: review this change"]);
    expect(sentOptions).toEqual([{ activeTurnBehavior }]);
  });
});
