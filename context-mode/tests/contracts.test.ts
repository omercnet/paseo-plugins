import { describe, expect, test } from "vitest";
import {
  BinaryStatusSchema,
  ContextModeSettingsSchema,
  getContextModeStatus,
  ProviderIntegrationSchema,
} from "../shared";

describe("Context Mode public contracts", () => {
  test("applies host-safe defaults", () => {
    expect(ContextModeSettingsSchema.parse({})).toEqual({
      binaryMode: "path",
      binaryPath: "",
      refreshIntervalMs: 15_000,
      showDoctorByDefault: false,
      autoInject: true,
      preferNativeIntegrations: true,
    });
  });

  test("accepts absolute configured paths and rejects relative ones", () => {
    expect(
      ContextModeSettingsSchema.safeParse({
        binaryMode: "path",
        binaryPath: "/opt/bin/context-mode",
      }).success,
    ).toBe(true);
    expect(
      ContextModeSettingsSchema.safeParse({ binaryMode: "path", binaryPath: "bin/context-mode" })
        .success,
    ).toBe(false);
    expect(
      ContextModeSettingsSchema.safeParse({
        binaryMode: "automatic",
        binaryPath: "bin/context-mode",
      }).success,
    ).toBe(true);
  });

  test("accepts typed cache bypass and rejects unrelated RPC input", () => {
    expect(getContextModeStatus.input.parse({})).toEqual({ fresh: false });
    expect(getContextModeStatus.input.parse({ fresh: true })).toEqual({ fresh: true });
    expect(getContextModeStatus.input.safeParse({ binaryPath: "/tmp/context-mode" }).success).toBe(
      false,
    );
  });

  test("validates runtime status states", () => {
    const ready = {
      state: "ready",
      binaryPath: "/usr/bin/context-mode",
      source: "path",
      version: "2.1.4",
      checkedAt: "2026-09-20T00:00:00.000Z",
    };
    expect(BinaryStatusSchema.safeParse(ready).success).toBe(true);
    expect(BinaryStatusSchema.safeParse({ ...ready, source: "global" }).success).toBe(false);
    expect(
      BinaryStatusSchema.safeParse({
        state: "unavailable",
        code: "unsupported",
        message: "x".repeat(4_097),
        checkedAt: ready.checkedAt,
      }).success,
    ).toBe(false);
  });

  test("reports one shared data dir and null platforms for unsupported providers", () => {
    const integration = {
      provider: "pi",
      platform: null,
      activation: "disabled",
      storageRoot: "/home/test/.context-mode",
      detail: "Unsupported.",
    };
    expect(ProviderIntegrationSchema.parse(integration)).toEqual(integration);
    expect(ProviderIntegrationSchema.safeParse({ ...integration, platform: "pi" }).success).toBe(
      false,
    );
  });
});
