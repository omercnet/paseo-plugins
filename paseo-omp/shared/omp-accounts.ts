import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

/** OMP provider ids such as `anthropic` or `openai-codex`; never a leading `-`, they end up in argv. */
export const OmpAccountProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/u);

export const OmpAccountRefSchema = z.object({
  store: OmpStoreSchema.optional(),
  provider: OmpAccountProviderIdSchema,
  credentialId: z.number().int().nonnegative(),
});
export type OmpAccountRef = z.infer<typeof OmpAccountRefSchema>;

/** One rate-limit window as OMP reports it; `resetsAt` is epoch milliseconds like `OmpQuota`. */
export const OmpAccountLimitSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedFraction: z.number().min(0),
  resetsAt: z.number().int().nullable(),
});
export type OmpAccountLimit = z.infer<typeof OmpAccountLimitSchema>;

export const OmpAccountResetsSchema = z.object({
  available: z.number().int(),
  /** OMP can spend one right now; otherwise `blockedReason` says why not. */
  usableNow: z.boolean(),
  blockedReason: z.string().nullable(),
  soonestExpiry: z.string().nullable(),
});
export type OmpAccountResets = z.infer<typeof OmpAccountResetsSchema>;

/** The account policy OMP's config holds for this login (`auth.accountPolicies`). */
export const OmpAccountSteeringSchema = z.object({
  /** New agents prefer this login for its provider while it has room. */
  preferred: z.boolean(),
  /** Quota kept unused on this login; null uses `retry.usageReservePct`. */
  reservePct: z.number().nullable(),
});
export type OmpAccountSteering = z.infer<typeof OmpAccountSteeringSchema>;

/** One login in OMP's own credential store. OMP picks between them itself. */
export const OmpAccountSchema = z.object({
  provider: OmpAccountProviderIdSchema,
  credentialId: z.number().int(),
  /** OAuth logins have usage and resets; API keys have neither. */
  oauth: z.boolean(),
  label: z.string(),
  limits: z.array(OmpAccountLimitSchema),
  /** When OMP read the limits shown (epoch ms); null when it has no reading for this login. */
  usageAt: z.number().int().nullable(),
  /** The reading is OMP's last recorded one, not live: the provider gave none in the latest fetch. */
  usageIsRecorded: z.boolean(),
  resets: OmpAccountResetsSchema.nullable(),
  /** Null when OMP gives no account id for this login, so its policies cannot select it. */
  steering: OmpAccountSteeringSchema.nullable(),
});
export type OmpAccount = z.infer<typeof OmpAccountSchema>;

export const OmpLoginStepSchema = z.enum([
  "starting",
  "waiting",
  "verifying",
  "done",
  "failed",
  "canceled",
]);
export type OmpLoginStep = z.infer<typeof OmpLoginStepSchema>;

export const OmpLoginSchema = z.object({
  id: z.string(),
  provider: OmpAccountProviderIdSchema,
  step: OmpLoginStepSchema,
  url: z.string().nullable(),
  /** OMP's own hint, such as a device code to enter on the page. */
  instructions: z.string().nullable(),
  /** OMP is waiting for the authorization code or redirect URL to be pasted back. */
  codePrompt: z.string().nullable(),
  message: z.string().nullable(),
});
export type OmpLogin = z.infer<typeof OmpLoginSchema>;

export const OmpAccountProviderSchema = z.object({
  id: OmpAccountProviderIdSchema,
  name: z.string(),
  authenticated: z.boolean(),
});
export type OmpAccountProvider = z.infer<typeof OmpAccountProviderSchema>;

/** Where OMP's balancer would start new sessions right now (`omp dry-balance`). */
export const OmpBalancePreviewSchema = z.object({
  provider: OmpAccountProviderIdSchema,
  model: z.string(),
  shares: z.array(z.object({ label: z.string(), percent: z.number() })),
});
export type OmpBalancePreview = z.infer<typeof OmpBalancePreviewSchema>;

/** OMP settings that steer how it uses its logins, each with OMP's current value. */
export const OMP_ACCOUNTS_SETTING_PATHS = [
  "retry.usageReservePct",
  "retry.usageReservePolicy",
  "retry.waitForUsageReset",
  "codexResets.autoRedeem",
  "codexResets.keepCredits",
  "claudeResets.autoRedeem",
  "claudeResets.keepCredits",
] as const;
export const OmpAccountsSettingPathSchema = z.enum(OMP_ACCOUNTS_SETTING_PATHS);
export type OmpAccountsSettingPath = z.infer<typeof OmpAccountsSettingPathSchema>;
export const OmpAccountsSettingsSchema = z.partialRecord(
  OmpAccountsSettingPathSchema,
  z.union([z.string(), z.number(), z.boolean()]),
);
export type OmpAccountsSettings = z.infer<typeof OmpAccountsSettingsSchema>;
export const OmpAccountsViewSchema = z.object({
  /** `omp` is on this host's PATH; everything else is empty when it is not. */
  installed: z.boolean(),
  /** Providers with a login plus the ones OMP offers sign-in for. */
  providers: z.array(OmpAccountProviderSchema),
  accounts: z.array(OmpAccountSchema),
  logins: z.array(OmpLoginSchema),
  balance: z.array(OmpBalancePreviewSchema),
  settings: OmpAccountsSettingsSchema,
  fetchedAt: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type OmpAccountsView = z.infer<typeof OmpAccountsViewSchema>;

export const listOmpAccounts = defineRpc({
  name: "paseo-omp.list-accounts",
  input: z.object({
    store: OmpStoreSchema.optional(),
    /** Ask the providers again instead of answering from OMP's usage cache. */
    refresh: z.boolean().optional(),
  }),
  output: OmpAccountsViewSchema,
});

export const startOmpAccountLogin = defineRpc({
  name: "paseo-omp.start-account-login",
  input: z.object({ store: OmpStoreSchema.optional(), provider: OmpAccountProviderIdSchema }),
  output: OmpLoginSchema,
});

export const submitOmpAccountLoginCode = defineRpc({
  name: "paseo-omp.submit-account-login-code",
  input: z.object({
    store: OmpStoreSchema.optional(),
    loginId: z.string(),
    code: z.string().trim().min(1).max(4096),
  }),
  output: OmpLoginSchema,
});

export const cancelOmpAccountLogin = defineRpc({
  name: "paseo-omp.cancel-account-login",
  input: z.object({ store: OmpStoreSchema.optional(), loginId: z.string() }),
  output: OmpLoginSchema.nullable(),
});

/** Signs one login out of OMP's store (`omp` rpc `logout`). */
export const removeOmpAccount = defineRpc({
  name: "paseo-omp.remove-account",
  input: OmpAccountRefSchema,
  output: z.object({ ok: z.literal(true) }),
});

/** Spends one banked reset (`omp usage reset <provider>/<credentialId>`). */
export const redeemOmpAccountReset = defineRpc({
  name: "paseo-omp.redeem-account-reset",
  input: OmpAccountRefSchema,
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Whether an account's steering can change or spend money is OMP's call; these only edit its config. */
export const setOmpAccountSteering = defineRpc({
  name: "paseo-omp.set-account-steering",
  input: OmpAccountRefSchema.extend({
    /** Make this the login new agents prefer for its provider, or drop that preference. */
    preferred: z.boolean().optional(),
    /** Quota OMP keeps unused on this login; null goes back to OMP's default reserve. */
    reservePct: z.number().int().min(0).max(90).nullable().optional(),
  }),
  output: z.object({ ok: z.literal(true) }),
});

export const setOmpAccountsSetting = defineRpc({
  name: "paseo-omp.set-accounts-setting",
  input: z.object({
    store: OmpStoreSchema.optional(),
    path: OmpAccountsSettingPathSchema,
    /** null resets the setting to OMP's default. */
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  }),
  output: z.object({ ok: z.literal(true) }),
});
