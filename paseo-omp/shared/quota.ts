import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

// omp's usage_history stores recorded_at/resets_at as epoch milliseconds (confirmed against
// live rows: 13-digit values), not seconds. Any "time remaining" math must diff against
// Date.now() directly, never Date.now() / 1000.
export const OmpQuotaSchema = z.object({
  provider: z.string(),
  /** Server-side SHA-256 identity; never the raw OMP credential/account key. */
  accountKey: z.string(),
  limitId: z.string(),
  email: z.string().nullable(),
  accountId: z.string().nullable(),
  /** Copilot login service: public GitHub or a GitHub Enterprise (GHE) host. */
  accountService: z.enum(["github", "ghe"]).nullable(),
  /** GHE hostname; null for public GitHub and every other provider. */
  accountHost: z.string().nullable(),
  /** Raw plan OMP's cached usage report names (Codex `planType`, Copilot `plan`). */
  plan: z.string().nullable().default(null),
  /** Organization name from OMP's cached usage report, when it is not just the plan. */
  organization: z.string().nullable().default(null),
  label: z.string(),
  windowLabel: z.string().nullable(),
  usedFraction: z.number().min(0).nullable(),
  status: z.string().nullable(),
  resetsAt: z.number().int().nullable(),
  recordedAt: z.number().int(),
});
export type OmpQuota = z.infer<typeof OmpQuotaSchema>;

export const listOmpQuotas = defineRpc({
  name: "paseo-omp.list-quotas",
  input: z.object({ store: OmpStoreSchema.optional() }),
  output: z.object({ quotas: z.array(OmpQuotaSchema) }),
});

/**
 * The OMP provider (such as `anthropic`) of the model an OMP Plugin agent's live session uses.
 * Paseo only sees that model as an opaque id, so the provider is null without a live session.
 */
export const getOmpSessionModelProvider = defineRpc({
  name: "paseo-omp.session-model-provider",
  input: z.object({ agentId: z.string().min(1).max(256) }),
  output: z.object({ provider: z.string().nullable() }),
});

export const OmpSessionAccountSchema = z.object({
  /** OMP's credential id; `/session pin OAuth credential #<id>` selects this login. */
  credentialId: z.number().int().nonnegative(),
  label: z.string(),
  /** OMP routes this session's requests to this login, as OMP itself reports or recorded it. */
  active: z.boolean(),
  /**
   * The provider's only stored credential of any kind. Not proof of use: an environment or explicit
   * key can still serve the session, so it is shown apart from `active` and never offered a switch.
   */
  onlyLogin: z.boolean(),
  /** `OmpQuota.accountKey` values recorded for this login. */
  quotaAccountKeys: z.array(z.string()),
});
export type OmpSessionAccount = z.infer<typeof OmpSessionAccountSchema>;

/** OAuth logins of the agent's current provider, as its live OMP session sees them. */
export const listOmpSessionAccounts = defineRpc({
  name: "paseo-omp.list-session-accounts",
  input: z.object({
    agentId: z.string().min(1).max(256),
    provider: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/u)
      .max(128),
  }),
  output: z.object({ accounts: z.array(OmpSessionAccountSchema) }),
});
