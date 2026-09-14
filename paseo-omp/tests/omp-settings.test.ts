import { describe, expect, test } from "vitest";
import { parseOmpSettingsList } from "../server/omp-settings";
import { categorizeOmpSetting, formatOmpSettingLabel } from "../shared/omp-settings";

describe("OMP settings inventory", () => {
  test("preserves typed values while withholding redacted values", () => {
    const settings = parseOmpSettingsList({
      "retry.enabled": {
        value: true,
        type: "boolean",
        description: "Retry failed requests",
      },
      "auth.broker.token": {
        value: "must-not-cross-the-rpc-boundary",
        redacted: true,
        type: "string",
        description: "",
      },
      unsupported: { value: true, type: "mystery" },
    });

    expect(settings).toEqual([
      {
        path: "retry.enabled",
        value: true,
        type: "boolean",
        description: "Retry failed requests",
      },
      {
        path: "auth.broker.token",
        redacted: true,
        type: "string",
        description: "",
      },
    ]);
    expect(JSON.stringify(settings)).not.toContain("must-not-cross-the-rpc-boundary");
  });

  test("rejects a non-object document", () => {
    expect(() => parseOmpSettingsList([])).toThrow("invalid settings document");
  });

  test("groups representative settings into OMP navigation categories", () => {
    expect(categorizeOmpSetting("theme.dark")).toBe("appearance");
    expect(categorizeOmpSetting("retry.maxRetries")).toBe("model");
    expect(categorizeOmpSetting("compaction.enabled")).toBe("context");
    expect(categorizeOmpSetting("mcp.notifications")).toBe("tools");
    expect(categorizeOmpSetting("task.maxConcurrency")).toBe("tasks");
    expect(categorizeOmpSetting("providers.fetch")).toBe("providers");
    expect(categorizeOmpSetting("setupVersion")).toBe("general");
  });

  test("formats dotted camel-case paths as readable labels", () => {
    expect(formatOmpSettingLabel("providers.streamIdleTimeoutSeconds")).toBe(
      "Stream Idle Timeout Seconds",
    );
  });
});
