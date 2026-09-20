import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const refreshInput = z.object({ fresh: z.boolean().default(false) }).strict();
const binarySource = z.enum(["settings", "path", "bundled"]);
const failureCode = z.enum([
  "not-installed",
  "invalid-settings",
  "timeout",
  "output-limit",
  "launch-failed",
  "protocol-error",
  "unsupported",
  "command-failed",
]);

export const BinaryStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    binaryPath: z.string(),
    source: binarySource,
    version: z.string().nullable(),
    supportsDoctor: z.boolean(),
    supportsStats: z.boolean(),
    checkedAt: z.string().datetime(),
  }),
  z.object({
    state: z.literal("unavailable"),
    code: failureCode,
    message: z.string().max(4_096),
    checkedAt: z.string().datetime(),
  }),
]);

export const CommandReportSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    binaryPath: z.string(),
    output: z.string().max(196_608),
    checkedAt: z.string().datetime(),
  }),
  z.object({
    state: z.literal("unavailable"),
    code: failureCode,
    message: z.string().max(4_096),
    checkedAt: z.string().datetime(),
  }),
]);

export const ProviderIntegrationSchema = z.object({
  provider: z.string(),
  platform: z.string(),
  activation: z.enum(["native", "mcp", "disabled"]),
  storageRoot: z.string(),
  reusesExistingStorage: z.boolean(),
  detail: z.string().max(4_096),
});

export const IntegrationAuditSchema = z.object({
  runtimePath: z.string(),
  runtimeVersion: z.string().nullable(),
  injectionEnabled: z.boolean(),
  providers: z.array(ProviderIntegrationSchema),
  checkedAt: z.string().datetime(),
});

export const getContextModeStatus = defineRpc({
  name: "context-mode.status",
  input: refreshInput,
  output: BinaryStatusSchema,
});

export const getContextModeDoctor = defineRpc({
  name: "context-mode.doctor",
  input: refreshInput,
  output: CommandReportSchema,
});

export const getContextModeStats = defineRpc({
  name: "context-mode.stats",
  input: refreshInput,
  output: CommandReportSchema,
});

export const getContextModeIntegrationAudit = defineRpc({
  name: "context-mode.integration-audit",
  input: refreshInput,
  output: IntegrationAuditSchema,
});

export type BinaryStatus = z.infer<typeof BinaryStatusSchema>;
export type CommandReport = z.infer<typeof CommandReportSchema>;
export type IntegrationAudit = z.infer<typeof IntegrationAuditSchema>;
export type ProviderIntegration = z.infer<typeof ProviderIntegrationSchema>;
export type ContextModeRefreshInput = z.infer<typeof refreshInput>;
