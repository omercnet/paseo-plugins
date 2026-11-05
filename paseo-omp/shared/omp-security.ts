import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

export const OMP_SECURITY_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
] as const;
export const OmpSecuritySeveritySchema = z.enum(OMP_SECURITY_SEVERITIES);
export type OmpSecuritySeverity = z.infer<typeof OmpSecuritySeveritySchema>;

export const OmpSecurityScanSchema = z.object({
  id: z.string(),
  /** OMP's scan status: planned, running, completed, partial, cancelled or failed. */
  phase: z.string(),
  findingCount: z.number().int().nonnegative(),
  /** Findings per severity. Counts only; finding titles and locations are never sent. */
  severities: z.record(OmpSecuritySeveritySchema, z.number().int().nonnegative()),
  /** False when OMP's finding listing was cut short, so the counts add up to less than `findingCount`. */
  severitiesComplete: z.boolean(),
  producer: z.string(),
  createdAt: z.string(),
});
export type OmpSecurityScan = z.infer<typeof OmpSecurityScanSchema>;

export const OmpSecurityListSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    scans: z.array(OmpSecurityScanSchema),
    /** More scans are stored than are listed. */
    truncated: z.boolean(),
    /** Lines of OMP's scan list the plugin could not read or that repeated an id. */
    skipped: z.number().int().nonnegative(),
  }),
  /** `security.enabled` is false, so OMP refuses to read its security resources. */
  z.object({ status: z.literal("off") }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type OmpSecurityList = z.infer<typeof OmpSecurityListSchema>;

/** Scans are keyed by project, so a workspace is required. */
export const listOmpSecurity = defineRpc({
  name: "paseo-omp.list-security",
  input: z.object({ store: OmpStoreSchema.optional(), cwd: OmpWorkspaceCwdSchema }).strict(),
  output: OmpSecurityListSchema,
});
