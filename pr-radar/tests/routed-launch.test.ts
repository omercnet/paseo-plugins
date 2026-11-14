import { describe, expect, test } from "vitest";
import {
  initialLaunchTarget,
  labelWorkspaceCwd,
  ROUTED_MODE_IDS,
  restrictRoutedLaunch,
} from "../client/radar";

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

describe("labelWorkspaceCwd", () => {
  test("assigns only the matching CWD tag", async () => {
    const calls: Array<[string, boolean]> = [];
    await labelWorkspaceCwd(
      { setLabel: (label, { assigned }) => calls.push([label, assigned]) },
      "CWD-WORKTREE",
    );
    expect(calls).toEqual([
      ["CWD-BASE", false],
      ["CWD-WORKTREE", true],
      ["CWD-TBD", false],
    ]);
  });

  test("propagates a setLabel failure", async () => {
    await expect(
      labelWorkspaceCwd({ setLabel: () => Promise.reject(new Error("denied")) }, "CWD-BASE"),
    ).rejects.toThrow("denied");
  });

  test("skips labelling on a host whose workspaces have no setLabel", async () => {
    await expect(labelWorkspaceCwd({}, "CWD-BASE")).resolves.toBeUndefined();
  });
});

describe("initialLaunchTarget", () => {
  test("never preselects cloning, with or without a local checkout", () => {
    expect(initialLaunchTarget({ localProjectRoot: null })).toEqual({
      selectedDir: null,
      allowClone: false,
    });
    expect(initialLaunchTarget({ localProjectRoot: "/work/repo" })).toEqual({
      selectedDir: "/work/repo",
      allowClone: false,
    });
  });
});
