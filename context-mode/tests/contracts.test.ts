import { describe, expect, test } from "vitest";
import {
  BinaryStatusSchema,
  getContextModeStatus,
  ProviderIntegrationSchema,
} from "../shared/contracts";
import { ContextModeSettingsSchema, contextModeSettings } from "../shared/settings";

describe("Context Mode public contracts", () => {
  test("defaults to the bundled runtime", () => {
    expect(ContextModeSettingsSchema.parse({})).toEqual({
      binaryPath: null,
      refreshIntervalMs: 15_000,
      autoInject: true,
      preferNativeIntegrations: true,
    });
  });

  test("accepts only an absolute path for your own binary", () => {
    expect(
      ContextModeSettingsSchema.safeParse({ binaryPath: "/opt/bin/context-mode" }).success,
    ).toBe(true);
    expect(ContextModeSettingsSchema.safeParse({ binaryPath: "C:\\cm\\cli.mjs" }).success).toBe(
      true,
    );
    for (const binaryPath of ["bin/context-mode", ""]) {
      expect(ContextModeSettingsSchema.safeParse({ binaryPath }).success).toBe(false);
    }
  });

  test("migrates version 1 settings, keeping only an explicitly configured path", async () => {
    const migrate = contextModeSettings.migrate;
    if (!migrate) throw new Error("settings must define a migration");
    const cases = [
      [{ binaryMode: "path", binaryPath: "", showDoctorByDefault: true, autoInject: false }, null],
      [{ binaryMode: "path", binaryPath: " /opt/context-mode " }, "/opt/context-mode"],
      [{ binaryMode: "automatic", binaryPath: "/opt/context-mode" }, null],
      [undefined, null],
    ] as const;
    for (const [stored, binaryPath] of cases) {
      const migrated = ContextModeSettingsSchema.parse(await migrate(stored, 1));
      expect(migrated.binaryPath).toBe(binaryPath);
    }
    expect(
      ContextModeSettingsSchema.parse(await migrate({ binaryMode: "path", autoInject: false }, 1))
        .autoInject,
    ).toBe(false);
  });

  test("accepts typed cache bypass and rejects unrelated RPC input", () => {
    expect(getContextModeStatus.input.parse({})).toEqual({ fresh: false });
    expect(getContextModeStatus.input.parse({ fresh: true })).toEqual({ fresh: true });
    expect(getContextModeStatus.input.safeParse({ binaryPath: "/tmp/context-mode" }).success).toBe(
      false,
    );
  });

  test("reports which runtime is in use", () => {
    const ready = {
      state: "ready",
      binaryPath: "/usr/bin/context-mode",
      source: "bundled",
      version: "2.1.4",
      checkedAt: "2026-09-20T00:00:00.000Z",
    };
    expect(BinaryStatusSchema.safeParse(ready).success).toBe(true);
    for (const source of ["path", "global"]) {
      expect(BinaryStatusSchema.safeParse({ ...ready, source }).success).toBe(false);
    }
  });

  test("marks providers Context Mode 2 cannot serve with a null platform", () => {
    const integration = { provider: "pi", platform: null, activation: "disabled", detail: "No." };
    expect(ProviderIntegrationSchema.parse(integration)).toEqual(integration);
    expect(ProviderIntegrationSchema.safeParse({ ...integration, platform: "pi" }).success).toBe(
      false,
    );
  });
});
