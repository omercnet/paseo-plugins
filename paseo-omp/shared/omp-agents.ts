import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpAgentNameSchema } from "./omp-settings";
import { OmpStoreSchema } from "./omp-store";

export const OMP_AGENT_LIMIT = 256;

export const OmpAgentSchema = z
  .object({ name: OmpAgentNameSchema, source: z.enum(["bundled", "user", "project"]) })
  .strict();
export type OmpAgent = z.infer<typeof OmpAgentSchema>;

export const listOmpAgents = defineRpc({
  name: "paseo-omp.list-agents",
  input: z
    .object({ store: OmpStoreSchema.optional(), cwd: OmpWorkspaceCwdSchema.optional() })
    .strict(),
  output: z
    .object({
      agents: z.array(OmpAgentSchema).max(OMP_AGENT_LIMIT),
      /** Set when the bundled agents could not be listed; user and project agents still appear. */
      error: z.string().max(256).optional(),
    })
    .strict(),
});
