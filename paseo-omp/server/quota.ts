import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { storeForProvider } from "../shared/omp-store";
import type { listOmpQuotas, listOmpSessionAccounts, OmpQuota } from "../shared/quota";
import { ompDataDir, withOmpStore } from "./paths";
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
    // A blank planType must not hide a plan the report names.
    const plan = metadata?.planType?.trim() || metadata?.plan?.trim() || null;
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

/**
 * OMP's own rule (`oauthMatchesActiveIdentity`): the organization gates the identity, so differing
 * organizations, or one present on only one side, never match; an email on both sides then
 * decides, else the account id. A record with no base identity matches on the organization alone.
 *
 * Two parts of OMP's rules are left out. `projectId` is not compared: OMP's usage keys carry no
 * project, and Antigravity logins share one project. An account id equal to the organization id
 * (a ChatGPT workspace id every member shares, which `isSameOAuthAccount` skips) is not excluded:
 * a usage key always carries the email where OMP recorded one, so the email decides first.
 */
function sameLogin(login: LoginIdentity, usage: LoginIdentity): boolean {
  if (login.orgId !== null || usage.orgId !== null) {
    if (login.orgId !== usage.orgId) return false;
    if (usage.email === null && usage.accountId === null) return true;
  }
  if (login.email && usage.email) return login.email.toLowerCase() === usage.email.toLowerCase();
  return login.accountId !== null && login.accountId === usage.accountId;
}

/** Any field OMP's identity rule compares, the organization included. */
function hasIdentity(identity: LoginIdentity): boolean {
  return identity.email !== null || identity.accountId !== null || identity.orgId !== null;
}

/**
 * The usage accounts recorded for each login. Only identity fields leave the credential row. A login
 * with an identity always has to match it. Only when neither the provider's single login nor its
 * single usage account carries one (Copilot keys hold a credential fingerprint) are the two linked
 * unchecked.
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
      const rows = database
        .prepare(
          `SELECT id, json_extract(data, '$.email') AS email,
                  json_extract(data, '$.accountId') AS accountId,
                  json_extract(data, '$.orgId') AS orgId
           FROM auth_credentials WHERE id IN (${credentialIds.map(() => "?").join(", ")})`,
        )
        .all(...credentialIds);
      const text = (value: unknown) => (typeof value === "string" && value.trim()) || null;
      for (const row of rows) {
        if (typeof row.id !== "number") continue;
        const login = {
          email: text(row.email),
          accountId: text(row.accountId),
          orgId: text(row.orgId),
        };
        if (hasIdentity(login)) {
          matched.set(
            row.id,
            usageKeys.filter((key) => sameLogin(login, usageKeyIdentity(key))).map(hashAccountKey),
          );
        } else if (
          credentialIds.length === 1 &&
          usageKeys.length === 1 &&
          !hasIdentity(usageKeyIdentity(usageKeys[0]))
        ) {
          matched.set(row.id, [hashAccountKey(usageKeys[0])]);
        }
      }
    } finally {
      database.close();
    }
  } catch {
    // An unreadable database only loses the link between logins and their recorded usage.
  }
  return matched;
}

/** The agent's provider and, for an OMP session Paseo persisted, OMP's session id. */
export type OmpSessionAgent = { provider: string; sessionId: string | null };
export type OmpSessionAgentLookup = (agentId: string) => Promise<OmpSessionAgent | null>;

/** Paseo's bundled `omp` provider and this plugin's providers both persist OMP's session id. */
export function sessionAgentFromPaseo(paseo: PluginHandlerContext["paseo"]): OmpSessionAgentLookup {
  return async (agentId) => {
    try {
      const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (!agent) return null;
      const persistence = agent.persistence;
      const omp = persistence && /^omp(-|$)/u.test(persistence.provider);
      return { provider: agent.provider, sessionId: (omp && persistence.sessionId) || null };
    } catch {
      return null;
    }
  };
}

const StickySchema = z.object({ type: z.string(), credentialId: z.number().int() });

/**
 * The provider's stored OAuth logins with the one OMP pinned to `sessionId` marked active. OMP
 * persists that pin as `session:sticky:<provider>:<session id>` for 30 days past its last use; a
 * session that never sent a request to the provider has none. Only identity fields are read.
 */
export function storedSessionLogins(
  path: string,
  provider: string,
  sessionId: string,
  nowSec = Math.floor(Date.now() / 1000),
): OmpLogoutAccount[] {
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      const sticky = database
        .prepare("SELECT value FROM cache WHERE key = ? AND expires_at > ?")
        .get(`session:sticky:${provider}:${sessionId}`, nowSec);
      let active: number | null = null;
      if (typeof sticky?.value === "string") {
        try {
          const parsed = StickySchema.safeParse(JSON.parse(sticky.value));
          if (parsed.success && parsed.data.type === "oauth") active = parsed.data.credentialId;
        } catch {
          // An unreadable pin only loses the active marker.
        }
      }
      const text = (value: unknown) => (typeof value === "string" && value.trim()) || null;
      // Every stored credential, API keys included, so "the only login" counts what OMP can use.
      return database
        .prepare(
          `SELECT id, credential_type AS type, json_extract(data, '$.email') AS email,
                  json_extract(data, '$.accountId') AS accountId,
                  json_extract(data, '$.orgName') AS orgName
           FROM auth_credentials
           WHERE provider = ? AND disabled_cause IS NULL
           ORDER BY id`,
        )
        .all(provider)
        .flatMap((row): OmpLogoutAccount[] => {
          if (typeof row.id !== "number") return [];
          if (row.type !== "oauth") {
            return [
              {
                credentialId: row.id,
                provider,
                label: `API key #${row.id}`,
                type: "api_key",
                active: false,
              },
            ];
          }
          // OMP's own label: the email or account id, then the organization in parentheses.
          const base = text(row.email) ?? text(row.accountId) ?? `OAuth credential #${row.id}`;
          const org = text(row.orgName);
          return [
            {
              credentialId: row.id,
              provider,
              label: org && org !== base ? `${base} (${org})` : base,
              type: "oauth",
              active: row.id === active,
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

/**
 * Logins and usage come from the agent's own store: a named-profile agent never reads the daemon
 * default store, whose credential ids belong to other accounts. The store follows the provider
 * Paseo reports for the agent, not anything the client sends.
 */
export async function resolveListOmpSessionAccounts(
  input: RpcInput<typeof listOmpSessionAccounts>,
  registry: OmpSubagentControlRegistry,
  findAgent: OmpSessionAgentLookup,
): Promise<RpcOutput<typeof listOmpSessionAccounts>> {
  const agent = await findAgent(input.agentId);
  // Without the agent its store is unknown; answering from the default store could name another
  // store's login that happens to share a credential id.
  if (!agent) return { accounts: [] };
  return await withOmpStore(storeForProvider(agent.provider), async () => {
    const databasePath = defaultDatabasePath();
    const logins = await sessionLogins(input, registry, agent.sessionId, databasePath);
    const oauth = logins.filter((login) => login.type === "oauth");
    const keys = quotaAccountKeysFor(
      databasePath,
      input.provider,
      oauth.map((login) => login.credentialId),
    );
    // One stored credential does not prove use (an environment or explicit key can serve the
    // session), so OMP's own `active` stands and the sole login is only flagged as such.
    const onlyLogin = logins.length === 1 && oauth.length === 1;
    return {
      accounts: oauth.map((login) => ({
        credentialId: login.credentialId,
        label: login.label,
        active: login.active,
        onlyLogin,
        quotaAccountKeys: keys.get(login.credentialId) ?? [],
      })),
    };
  });
}

/**
 * A live OMP Plugin session answers itself. Any other OMP session (Paseo's bundled `omp` provider,
 * or a plugin session not open in this daemon) falls back to the pin OMP recorded for it.
 */
async function sessionLogins(
  input: RpcInput<typeof listOmpSessionAccounts>,
  registry: OmpSubagentControlRegistry,
  sessionId: string | null,
  databasePath: string,
): Promise<OmpLogoutAccount[]> {
  const controls = registry.get(input.agentId);
  if (!controls) {
    return sessionId ? storedSessionLogins(databasePath, input.provider, sessionId) : [];
  }
  try {
    return await controls.listProviderAccounts(input.provider);
  } catch (error) {
    if (isOmpPublicError(error)) throw error;
    if (error instanceof OmpRpcRequestRejectedError && error.code === "unsupported_command") {
      throw new OmpPublicError("Update OMP to show which login this session uses");
    }
    // Native OMP error text is never forwarded.
    throw new OmpPublicError("OMP could not list this session's logins");
  }
}
