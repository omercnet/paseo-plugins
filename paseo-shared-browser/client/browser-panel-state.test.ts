import { describe, expect, it } from "vitest";
import { browserPanelStateSchema, DEFAULT_BROWSER_PANEL_STATE } from "./browser-panel-state";

describe("persisted browser panel state", () => {
  it("round-trips a remembered tab and display mode", () => {
    const state = { scaleMode: "actual", selectedTabId: "page-2" };
    expect(browserPanelStateSchema.parse(state)).toEqual(state);
  });

  it("accepts its own default", () => {
    expect(browserPanelStateSchema.safeParse(DEFAULT_BROWSER_PANEL_STATE).success).toBe(true);
  });

  it("rejects state that a newer or older plugin version could have written", () => {
    expect(browserPanelStateSchema.safeParse(undefined).success).toBe(false);
    expect(
      browserPanelStateSchema.safeParse({ scaleMode: "zoom", selectedTabId: null }).success,
    ).toBe(false);
    expect(browserPanelStateSchema.safeParse({ scaleMode: "fit", selectedTabId: 3 }).success).toBe(
      false,
    );
  });
});
