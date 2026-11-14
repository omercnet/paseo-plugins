import { describe, expect, test } from "vitest";
import {
  buildAgentConfig,
  initialLaunchTarget,
  labelWorkspaceCwd,
  ROUTED_MODE_IDS,
  restrictRoutedLaunch,
  routedProviderModel,
  vetRoutedProfile,
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

describe("routedProviderModel", () => {
  test("clears the model when the routed provider differs and no model is routed", () => {
    expect(routedProviderModel({ provider: "claude" }, { provider: "codex" })).toEqual({
      provider: "codex",
      model: "",
    });
  });

  test("keeps a routed model with a routed provider", () => {
    expect(
      routedProviderModel({ provider: "claude" }, { provider: "codex", model: "gpt-x" }),
    ).toEqual({
      provider: "codex",
      model: "gpt-x",
    });
  });

  test("leaves the model alone when the provider is unchanged or not routed", () => {
    expect(routedProviderModel({ provider: "codex" }, { provider: "codex" })).toEqual({
      provider: "codex",
    });
    expect(routedProviderModel({ provider: "codex" }, {})).toEqual({});
    expect(routedProviderModel({ provider: "codex" }, { model: "gpt-x" })).toEqual({
      model: "gpt-x",
    });
  });

  test("builds a provider-only agent config without the old provider's model", () => {
    const picked = routedProviderModel({ provider: "claude" }, { provider: "codex" });
    const config = buildAgentConfig(undefined, { provider: "claude", model: "sonnet", ...picked });
    expect(config.provider).toBe("codex");
  });
});

describe("vetRoutedProfile", () => {
  const yolo = { name: "yolo", provider: "claude", modeId: "bypassPermissions" };
  const safe = { name: "Safe", provider: "claude", modeId: "plan", options: { contextMode: "x" } };
  const base = { name: "Base", provider: "claude" };

  test("a script cannot reach bypassPermissions by naming a profile", () => {
    const vetted = vetRoutedProfile([base, yolo], "YOLO");
    expect(vetted).toEqual({ ignored: ["profile YOLO"] });
    // The caller keeps the user's profile, so the created config never carries the bypass mode.
    const config = buildAgentConfig(base, {});
    expect(config).not.toHaveProperty("modeId", "bypassPermissions");
  });

  test("rejects a profile whose options or feature values hold other keys", () => {
    for (const extra of [
      { options: { dangerouslySkipPermissions: true } },
      { featureValues: { fast: true } },
    ]) {
      expect(vetRoutedProfile([{ ...base, ...extra }], "Base")).toEqual({
        ignored: ["profile Base"],
      });
    }
  });

  test("rejects an unknown profile and accepts a safe one", () => {
    expect(vetRoutedProfile([base], "ghost")).toEqual({ ignored: ["profile ghost"] });
    expect(vetRoutedProfile([safe, base], "safe")).toEqual({ profileName: "Safe", ignored: [] });
    expect(vetRoutedProfile([base], "Base")).toEqual({ profileName: "Base", ignored: [] });
    expect(vetRoutedProfile([base], undefined)).toEqual({ ignored: [] });
  });
});
