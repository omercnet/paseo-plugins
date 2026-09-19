import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

export const OMP_SUPPORT_REPORT_SCHEMA_VERSION = 1 as const;
export const OMP_SUPPORT_REPORT_MAX_BYTES = 64 * 1024;
export const OMP_SUPPORT_ISSUE_URL =
  "https://github.com/omercnet/paseo-plugins/issues/new?template=omp-plugin.yml";

export function supportReportByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const OmpSupportReportTextSchema = z
  .string()
  .min(1)
  .refine((value) => supportReportByteLength(value) <= OMP_SUPPORT_REPORT_MAX_BYTES, {
    message: "OMP support report exceeds 64 KiB",
  });

export const getOmpSupportReport = defineRpc({
  name: "paseo-omp.get-support-report",
  input: z
    .object({
      store: OmpStoreSchema.optional(),
      force: z.boolean().optional(),
      cwd: OmpWorkspaceCwdSchema.optional(),
    })
    .strict(),
  output: z.object({ report: OmpSupportReportTextSchema }).strict(),
});
