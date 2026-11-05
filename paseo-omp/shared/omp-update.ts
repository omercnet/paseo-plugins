import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Bounded so nothing unbounded from `omp update --check` output crosses the RPC. */
const OmpUpdateVersionSchema = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/);

/** `unknown` means the check could not run or its output was not understood: never a guess. */
export const OmpUpdateStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("up-to-date") }),
  z.object({ state: z.literal("available"), version: OmpUpdateVersionSchema }),
  z.object({ state: z.literal("unknown") }),
]);
export type OmpUpdateStatus = z.infer<typeof OmpUpdateStatusSchema>;

export const getOmpUpdateStatus = defineRpc({
  name: "paseo-omp.get-update-status",
  input: z.object({ force: z.boolean().optional() }),
  output: OmpUpdateStatusSchema,
});

export const installOmpUpdate = defineRpc({
  name: "paseo-omp.install-update",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string(), status: OmpUpdateStatusSchema }),
});
