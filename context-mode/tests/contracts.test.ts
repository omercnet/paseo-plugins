import { describe, expect, test } from "vitest";
import {
  BinaryStatusSchema,
  CommandReportSchema,
  ContextModeSettingsSchema,
  getContextModeDoctor,
  getContextModeStats,
  getContextModeStatus,
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
    for (const contract of [getContextModeStatus, getContextModeDoctor, getContextModeStats]) {
      expect(contract.input.parse({})).toEqual({ fresh: false });
      expect(contract.input.parse({ fresh: true })).toEqual({ fresh: true });
      expect(contract.input.safeParse({ binaryPath: "/tmp/context-mode" }).success).toBe(false);
    }
  });

  test("rejects oversized upstream output and malformed states", () => {
    expect(
      CommandReportSchema.safeParse({
        state: "ready",
        binaryPath: "/usr/bin/context-mode",
        output: "x".repeat(196_609),
        checkedAt: "2026-09-20T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      BinaryStatusSchema.safeParse({
        state: "ready",
        binaryPath: "/usr/bin/context-mode",
        source: "path",
        version: "2.0.5",
        supportsDoctor: true,
        supportsStats: true,
        checkedAt: "2026-09-20T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
