import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ContextModePlatformSchema, ContextModeProviderSchema } from "./knowledge";

export const CONTEXT_MODE_TARGET_VERSION = "2.1.4" as const;

const providerInput = z.object({ provider: ContextModeProviderSchema }).strict();

export const DoctorStatusRowSchema = z
  .object({
    status: z.enum(["ok", "warning", "error"]),
    check: z.string().trim().min(1).max(256),
    detail: z.string().max(4_096),
    fix: z.string().max(4_096).optional(),
  })
  .strict();

export const DoctorReportSchema = z
  .object({
    platform: ContextModePlatformSchema,
    rows: z.array(DoctorStatusRowSchema).max(64),
    rawOutput: z.string().max(192 * 1_024),
  })
  .strict();

const CommandSchema = z
  .object({
    program: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(32),
  })
  .strict();

export const ContextModeActionSchema = CommandSchema.extend({
  /** A second command to run after `program`, e.g. `context-mode setup` after the npm install. */
  followUp: CommandSchema.optional(),
  currentVersion: z.string().trim().min(1).max(128).nullable(),
  targetVersion: z.union([z.literal(CONTEXT_MODE_TARGET_VERSION), z.literal("latest")]),
  platform: ContextModePlatformSchema,
  requiresRestart: z.boolean(),
}).strict();

export const getContextModeDoctorReport = defineRpc({
  name: "context-mode.actions.doctor",
  input: providerInput,
  output: DoctorReportSchema,
});

export const getContextModeInstallAction = defineRpc({
  name: "context-mode.actions.install",
  input: providerInput,
  output: ContextModeActionSchema,
});

export const getContextModeUpgradeAction = defineRpc({
  name: "context-mode.actions.upgrade",
  input: providerInput,
  output: ContextModeActionSchema,
});

export type DoctorStatusRow = z.infer<typeof DoctorStatusRowSchema>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export type ContextModeAction = z.infer<typeof ContextModeActionSchema>;
export type ContextModeActionInput = z.infer<typeof providerInput>;
