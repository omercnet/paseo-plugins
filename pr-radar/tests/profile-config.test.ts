import { describe, expect, test } from "vitest";
import { profileAgentConfig } from "../client/radar";

describe("profileAgentConfig", () => {
  test("carries the provider options a Paseo 0.16 profile stores as options", () => {
    expect(
      profileAgentConfig({
        provider: "codex",
        model: "gpt-5",
        options: { reasoning_summary: "auto" },
      }),
    ).toEqual({
      provider: "codex/gpt-5",
      options: { reasoning_summary: "auto" },
    });
  });

  test("carries featureValues from a profile a pre-0.16 host handed over", () => {
    expect(
      profileAgentConfig({
        provider: "codex",
        modeId: "auto",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    ).toEqual({
      provider: "codex",
      modeId: "auto",
      thinkingOptionId: "high",
      options: { fast_mode: true },
    });
  });

  test("merges both fields and lets an explicit options key win", () => {
    expect(
      profileAgentConfig({
        provider: "codex",
        featureValues: { fast_mode: true, service_tier: "flex" },
        options: { service_tier: "fast" },
      }),
    ).toEqual({
      provider: "codex",
      options: { fast_mode: true, service_tier: "fast" },
    });
  });

  test("never sends the deprecated featureValues or an invented providerOptions key", () => {
    const config = profileAgentConfig({
      provider: "codex",
      featureValues: { fast_mode: true },
      options: { service_tier: "fast" },
    });

    expect(config).not.toHaveProperty("featureValues");
    expect(config).not.toHaveProperty("providerOptions");
  });

  test("sends no options when the profile has none or only empty ones", () => {
    expect(profileAgentConfig({ provider: "claude" })).toEqual({ provider: "claude" });
    expect(profileAgentConfig({ provider: "claude", options: {}, featureValues: {} })).toEqual({
      provider: "claude",
    });
  });
});
