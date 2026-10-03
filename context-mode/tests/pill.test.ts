import { expect, test, vi } from "vitest";
import { contributeContextModeComposerPills } from "../client/context-mode-pill";

test("pill opens Knowledge by IDs on new hosts and the unscoped surface on old hosts", async () => {
  for (const supported of [true, false]) {
    let press: () => void = () => {};
    const client = {
      paseo: {
        agents: {
          list: async () => ({
            subscription: {
              subscribe(observer: { snapshot(input: unknown): void }) {
                observer.snapshot({
                  entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }],
                });
                return () => {};
              },
              release: vi.fn(),
            },
          }),
        },
      },
      addComposerPill: vi.fn((input) => {
        press = input.button.behavior.onPress;
        return { remove: vi.fn() };
      }),
      addScreen: supported ? vi.fn() : undefined,
      openScreen: supported ? vi.fn() : undefined,
      openSurface: vi.fn(),
    };
    const cleanup = contributeContextModeComposerPills(client as never);
    await Promise.resolve();
    press();
    if (supported) {
      expect(client.openScreen).toHaveBeenCalledWith({
        screenId: "context-mode",
        params: { section: "knowledge", agentId: "a", workspaceId: "w" },
      });
      expect(client.openSurface).not.toHaveBeenCalled();
    } else expect(client.openSurface).toHaveBeenCalledWith("context-mode");
    cleanup();
  }
});
