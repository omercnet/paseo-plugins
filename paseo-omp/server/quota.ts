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

/** OMP usageCacheIdentity records enterpriseUrl separately from its opaque credential fingerprint. */
function copilotAccountHost(accountKey: string): string | null {
  if (!accountKey.startsWith("oauth|") && !accountKey.startsWith("api_key|")) return null;
  const enterprise = accountKey.split("|").find((part) => part.startsWith("enterprise:"));
  if (!enterprise) return "github.com";
  const value = enterprise.slice("enterprise:".length);
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname || null;
  } catch {
    return null;
  }
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
            accountHost: copilot ? copilotAccountHost(quota.accountKey) : null,
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
