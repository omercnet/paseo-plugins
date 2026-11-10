import { describe, expect, test } from "vitest";
import { profileAgentConfig } from "../client/radar";

describe("profileAgentConfig", () => {
  test("carries the provider options a Paseo 0.16 profile stores as options", () => {
    const config = profileAgentConfig({
      provider: "codex",
      model: "gpt-5",
      options: { reasoning_summary: "auto" },
    });

    expect(config).toEqual({
      provider: "codex/gpt-5",
      providerOptions: { reasoning_summary: "auto" },
    });
  });

  test("still carries featureValues from a profile saved before 0.16", () => {
    const config = profileAgentConfig({
      provider: "codex",
      modeId: "auto",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    });

    expect(config).toEqual({
      provider: "codex",
      modeId: "auto",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    });
  });

  test("sends only the provider when the profile sets nothing else", () => {
    expect(profileAgentConfig({ provider: "claude" })).toEqual({ provider: "claude" });
  });
});
