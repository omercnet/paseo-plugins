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
});
