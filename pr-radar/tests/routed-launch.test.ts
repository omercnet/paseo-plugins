import { describe, expect, test } from "vitest";
import { ROUTED_MODE_IDS, restrictRoutedLaunch } from "../client/radar";

describe("restrictRoutedLaunch", () => {
  test("keeps an allow-listed mode and option", () => {
    expect(restrictRoutedLaunch({ modeId: "plan", options: { contextMode: "compact" } })).toEqual({
      modeId: "plan",
      options: { contextMode: "compact" },
      ignored: [],
    });
  });

  test("never lets a script pick a mode that skips permission prompts", () => {
    expect(ROUTED_MODE_IDS).not.toContain("bypassPermissions");
    for (const modeId of ["bypassPermissions", "dontAsk", "full-access"]) {
      expect(restrictRoutedLaunch({ modeId })).toEqual({ ignored: [`modeId ${modeId}`] });
    }
  });

  test("drops option keys outside the allow-list", () => {
    expect(
      restrictRoutedLaunch({ options: { contextMode: "full", dangerouslySkipPermissions: true } }),
    ).toEqual({
      options: { contextMode: "full" },
      ignored: ["options.dangerouslySkipPermissions"],
    });
  });

  test("returns nothing for an empty result", () => {
    expect(restrictRoutedLaunch({})).toEqual({ ignored: [] });
  });
});
