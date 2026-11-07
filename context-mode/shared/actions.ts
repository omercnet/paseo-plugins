import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ContextModePlatformSchema, ContextModeProviderSchema } from "./providers";

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

export const getContextModeDoctorReport = defineRpc({
  name: "context-mode.actions.doctor",
  input: providerInput,
  output: DoctorReportSchema,
});

export type DoctorStatusRow = z.infer<typeof DoctorStatusRowSchema>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export type ContextModeActionInput = z.infer<typeof providerInput>;
