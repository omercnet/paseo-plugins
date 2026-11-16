import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import type { listOmpQuotas, listOmpSessionAccounts, OmpQuota } from "../shared/quota";
import { ompDataDir } from "./paths";
import type { OmpLogoutAccount } from "./provider/omp-rpc-protocol";
import { OmpRpcRequestRejectedError } from "./provider/omp-rpc-transport";
import { isOmpPublicError, OmpPublicError } from "./provider/security";
import type { OmpSubagentControlRegistry } from "./subagents";

const QuotaRowSchema = z.object({
  provider: z.string(),
  accountKey: z.string(),
  limitId: z.string(),
  email: z.string().nullable(),
  accountId: z.string().nullable(),
  label: z.string(),
  windowLabel: z.string().nullable(),
  usedFraction: z.number().min(0).nullable(),
  status: z.string().nullable(),
  resetsAt: z.number().int().nullable(),
  recordedAt: z.number().int(),
});

// Reset-less rows (no resets_at) refresh on every OMP poll, so one this old is an inactive provider.
const ABANDONED_AFTER_MS = 30 * 86_400_000;

type CopilotAccount = Pick<OmpQuota, "accountService" | "accountHost">;
const UNKNOWN_SERVICE: CopilotAccount = { accountService: null, accountHost: null };

/** OMP usageCacheIdentity records enterpriseUrl separately from its opaque credential fingerprint. */
function copilotAccount(accountKey: string): CopilotAccount {
  if (!accountKey.startsWith("oauth|") && !accountKey.startsWith("api_key|")) {
    return UNKNOWN_SERVICE;
  }
  const enterprise = accountKey.split("|").find((part) => part.startsWith("enterprise:"));
  if (!enterprise) return { accountService: "github", accountHost: null };
  const value = enterprise.slice("enterprise:".length);
  if (!value) return UNKNOWN_SERVICE;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      return UNKNOWN_SERVICE;
    }
    return url.hostname ? { accountService: "ghe", accountHost: url.hostname } : UNKNOWN_SERVICE;
  } catch {
    return UNKNOWN_SERVICE;
  }
}

const CachedReportSchema = z.object({
  value: z.object({
    provider: z.string(),
    fetchedAt: z.number(),
    metadata: z
      .object({
        plan: z.string().nullish(),
        planType: z.string().nullish(),
        orgName: z.string().nullish(),
      })
      .nullish(),
  }),
});

type AccountTags = Pick<OmpQuota, "plan" | "organization">;
type CachedReport = AccountTags & { key: string; provider: string; fetchedAt: number };

/** OMP's usage cache; missing on older OMP versions, so any failure yields no tags. */
function readCachedReports(database: DatabaseSync): CachedReport[] {
  let rows: Record<string, unknown>[];
  try {
    rows = database
      .prepare("SELECT key, value FROM cache WHERE key LIKE 'usage_cache:report:%'")
      .all();
  } catch {
    return [];
  }
  return rows.flatMap(({ key, value }) => {
    if (typeof key !== "string" || typeof value !== "string") return [];
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      return [];
    }
    const parsed = CachedReportSchema.safeParse(json);
    if (!parsed.success) return [];
    const { provider, fetchedAt, metadata } = parsed.data.value;
    const plan = (metadata?.planType ?? metadata?.plan)?.trim() || null;
    const organization = metadata?.orgName?.trim() || null;
    return [
      {
        key,
        provider,
        fetchedAt,
        plan,
        // Codex reports its plan as the organization name too; that is not an organization.
        organization: organization?.toLowerCase() === plan?.toLowerCase() ? null : organization,
      },
    ];
  });
}

/** OMP caches each report under a key that ends with the account_key usage_history records. */
function accountTags(
  reports: readonly CachedReport[],
  provider: string,
  accountKey: string,
): AccountTags {
  const matches = reports
    .filter((report) => report.provider === provider && report.key.endsWith(`:${accountKey}`))
    .sort((a, b) => b.fetchedAt - a.fetchedAt);
  return {
    plan: matches.find((report) => report.plan)?.plan ?? null,
    organization: matches.find((report) => report.organization)?.organization ?? null,
  };
}

// Only live windows are returned: a series whose newest row already reset (or never resets and was
// abandoned) would otherwise pin the pill at its last exhausted value and bloat the popover.
export function listOmpQuotasFrom(path: string, now = Date.now()): OmpQuota[] {
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      const columns = database.prepare("PRAGMA table_info(usage_history)").all();
      const emailColumn = columns.some((column) => column.name === "email")
        ? "email"
        : "NULL AS email";
      const accountIdColumn = columns.some((column) => column.name === "account_id")
        ? "account_id"
        : "NULL AS account_id";
      const rows = database
        .prepare(
          `SELECT provider, account_key AS accountKey, limit_id AS limitId, email,
                  account_id AS accountId, label,
                  window_label AS windowLabel, used_fraction AS usedFraction,
                  status, resets_at AS resetsAt, recorded_at AS recordedAt
           FROM (
             SELECT provider, account_key, ${emailColumn}, ${accountIdColumn},
                    limit_id, label, window_label, used_fraction, status, resets_at, recorded_at, id,
                    ROW_NUMBER() OVER (
                      PARTITION BY provider, account_key, limit_id
                      ORDER BY recorded_at DESC, id DESC
                    ) AS position
             FROM usage_history
           )
           WHERE position = 1
             AND (resets_at > ? OR (resets_at IS NULL AND recorded_at > ?))
           ORDER BY COALESCE(usedFraction, -1) DESC, provider, label, accountKey, limitId`,
        )
        .all(now, now - ABANDONED_AFTER_MS);
      const reports = readCachedReports(database);
      return rows.flatMap((row) => {
        const parsed = QuotaRowSchema.safeParse(row);
        if (!parsed.success) return [];
        const quota = parsed.data;
        const copilot = quota.provider === "github-copilot";
        return [
          {
            ...quota,
            accountKey: createHash("sha256").update(quota.accountKey).digest("hex"),
            // account_id is only known to be a username for Copilot; other providers keep it private.
            accountId: copilot ? quota.accountId : null,
            ...(copilot ? copilotAccount(quota.accountKey) : UNKNOWN_SERVICE),
            ...accountTags(reports, quota.provider, quota.accountKey),
          },
        ];
      });
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}
export function resolveListOmpQuotas(_input: RpcInput<typeof listOmpQuotas>): {
  quotas: OmpQuota[];
} {
  return { quotas: listOmpQuotasFrom(defaultDatabasePath()) };
}

function defaultDatabasePath(): string {
  return join(ompDataDir(), "agent.db");
}

function hashAccountKey(accountKey: string): string {
  return createHash("sha256").update(accountKey).digest("hex");
}

type LoginIdentity = { email: string | null; accountId: string | null; orgId: string | null };

/** OMP's usage_history account_key is `oauth|account:<id>|email:<email>|org:<id>`. */
function usageKeyIdentity(accountKey: string): LoginIdentity {
  const parts = new Map<string, string>();
  for (const part of accountKey.split("|")) {
    const colon = part.indexOf(":");
    if (colon > 0) parts.set(part.slice(0, colon), part.slice(colon + 1));
  }
  return {
    email: parts.get("email") || null,
    accountId: parts.get("account") || null,
    orgId: parts.get("org") || null,
  };
}

/** OMP's own rule: differing orgs never match, an email on both sides decides, else the account id. */
function sameLogin(login: LoginIdentity, usage: LoginIdentity): boolean {
  if (login.orgId && usage.orgId && login.orgId !== usage.orgId) return false;
  if (login.email && usage.email) return login.email.toLowerCase() === usage.email.toLowerCase();
  return login.accountId !== null && login.accountId === usage.accountId;
}

/**
 * The usage accounts recorded for each login. Only identity fields leave the credential row; a
 * provider with one login and one usage account needs none (Copilot keys hold only a fingerprint).
 */
export function quotaAccountKeysFor(
  path: string,
  provider: string,
  credentialIds: readonly number[],
): Map<number, string[]> {
  const matched = new Map<number, string[]>(credentialIds.map((id) => [id, []]));
  if (credentialIds.length === 0) return matched;
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      const usageKeys = database
        .prepare("SELECT DISTINCT account_key AS accountKey FROM usage_history WHERE provider = ?")
        .all(provider)
        .flatMap(({ accountKey }) => (typeof accountKey === "string" ? [accountKey] : []));
      if (credentialIds.length === 1 && usageKeys.length === 1) {
        matched.set(credentialIds[0], [hashAccountKey(usageKeys[0])]);
        return matched;
      }
      const rows = database
        .prepare(
          `SELECT id, json_extract(data, '$.email') AS email,
                  json_extract(data, '$.accountId') AS accountId,
                  json_extract(data, '$.orgId') AS orgId
           FROM auth_credentials WHERE id IN (${credentialIds.map(() => "?").join(", ")})`,
        )
        .all(...credentialIds);
      for (const row of rows) {
        if (typeof row.id !== "number") continue;
        const text = (value: unknown) => (typeof value === "string" && value.trim()) || null;
        const login = {
          email: text(row.email),
          accountId: text(row.accountId),
          orgId: text(row.orgId),
        };
        if (!login.email && !login.accountId) continue;
        matched.set(
          row.id,
          usageKeys.filter((key) => sameLogin(login, usageKeyIdentity(key))).map(hashAccountKey),
        );
      }
    } finally {
      database.close();
    }
  } catch {
    // An unreadable database only loses the link between logins and their recorded usage.
  }
  return matched;
}

export async function resolveListOmpSessionAccounts(
  input: RpcInput<typeof listOmpSessionAccounts>,
  registry: OmpSubagentControlRegistry,
  databasePath = defaultDatabasePath(),
): Promise<RpcOutput<typeof listOmpSessionAccounts>> {
  const controls = registry.get(input.agentId);
  if (!controls) throw new OmpPublicError("This agent has no running OMP Plugin session");
  let logins: OmpLogoutAccount[];
  try {
    logins = await controls.listProviderAccounts(input.provider);
  } catch (error) {
    if (isOmpPublicError(error)) throw error;
    if (error instanceof OmpRpcRequestRejectedError && error.code === "unsupported_command") {
      throw new OmpPublicError("Update OMP to show which login this session uses");
    }
    // Native OMP error text is never forwarded.
    throw new OmpPublicError("OMP could not list this session's logins");
  }
  const oauth = logins.filter((login) => login.type === "oauth");
  const keys = quotaAccountKeysFor(
    databasePath,
    input.provider,
    oauth.map((login) => login.credentialId),
  );
  return {
    accounts: oauth.map((login) => ({
      credentialId: login.credentialId,
      label: login.label,
      active: login.active,
      quotaAccountKeys: keys.get(login.credentialId) ?? [],
    })),
  };
}
