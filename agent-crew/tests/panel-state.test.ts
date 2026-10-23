import { describe, expect, test } from "vitest";
import { DEFAULT_PANEL_STATE, panelStateSchema } from "../client/panel-state";

describe("panel state schema", () => {
  test("round-trips a persisted state", () => {
    const saved = { state: "needs-input", query: "review", collapsedAgentIds: ["a1", "a2"] };
    expect(panelStateSchema.parse(saved)).toEqual(saved);
  });

  test("never-written tab state parses to the defaults", () => {
    expect(panelStateSchema.safeParse(undefined).success).toBe(false);
    expect(panelStateSchema.parse({})).toEqual(DEFAULT_PANEL_STATE);
  });

  test("an invalid field falls back alone and keeps the valid ones", () => {
    expect(
      panelStateSchema.parse({ state: "bogus", query: "keep me", collapsedAgentIds: ["a1"] }),
    ).toEqual({ state: null, query: "keep me", collapsedAgentIds: ["a1"] });
    expect(
      panelStateSchema.parse({ state: "working", query: 7, collapsedAgentIds: [1, "a1"] }),
    ).toEqual({ state: "working", query: "", collapsedAgentIds: [] });
  });
});
