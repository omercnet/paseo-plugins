import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { listOmpQuotas, OmpQuota } from "../shared/quota";
import { ompDataDir } from "./paths";

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
    // A key range on the primary key (";" follows ":"), where LIKE would scan the whole cache.
    rows = database
      .prepare(
        "SELECT key, value FROM cache WHERE key >= 'usage_cache:report:' AND key < 'usage_cache:report;'",
      )
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

/**
 * OMP caches each report under a key that ends with the account_key usage_history records. Both
 * tags come from the newest report naming either, so two reports are never mixed into one badge row.
 */
function accountTags(
  reports: readonly CachedReport[],
  provider: string,
  accountKey: string,
): AccountTags {
  const best = reports
    .filter((report) => report.provider === provider && report.key.endsWith(`:${accountKey}`))
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .find((report) => report.plan || report.organization);
  return { plan: best?.plan ?? null, organization: best?.organization ?? null };
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
  return { quotas: listOmpQuotasFrom(join(ompDataDir(), "agent.db")) };
}
