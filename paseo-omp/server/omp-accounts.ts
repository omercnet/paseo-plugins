import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  OMP_ACCOUNTS_SETTING_PATHS,
  type OmpAccount,
  type OmpAccountLimit,
  type OmpAccountProvider,
  type OmpAccountSteering,
  type OmpAccountsSettingPath,
  type OmpAccountsSettings,
  type OmpAccountsView,
  type OmpBalancePreview,
  type OmpLogin,
  type OmpLoginStep,
} from "../shared/omp-accounts";
import type { OmpStore } from "../shared/omp-store";
import { SerialMutationQueue } from "./mutation-queue";
import { resolveOmpExecutable } from "./omp-settings";
import { currentOmpEnvironment } from "./paths";
import { OmpPublicError } from "./provider/security";
import { buildStatefulCommandEnv, defaultSpawn, runBounded } from "./provider-diagnostics";

/** Polls read OMP again at most this often; an explicit refresh reads it now. */
const SNAPSHOT_TTL_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const REDEEM_TIMEOUT_MS = 120_000;
const RPC_REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const FINISHED_LOGIN_TTL_MS = 10 * 60_000;
const KILL_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const BALANCE_SAMPLES = "20";

/** A bare rpc session: no tools, extensions or context, nothing saved. Only account commands run. */
const RPC_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-ui",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-lsp",
  "--no-title",
];

export class OmpAccountsError extends OmpPublicError {}

interface OmpCommand {
  executable: string;
  env: NodeJS.ProcessEnv;
}

// Everything `omp` prints is read through these schemas. An entry that does not fit is left out,
// so one odd entry never hides the rest of the accounts.

function entries<T extends z.ZodType>(entry: T) {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = entry.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

const EpochMs = z.number().int();
/** Used share of a limit, 0-1 and above 1 past it. */
const UsedFraction = z.number().min(0).max(100);
const OptionalText = z.string().optional().catch(undefined);

const FrameSchema = z.object({
  type: OptionalText,
  id: OptionalText,
  success: z.boolean().optional().catch(undefined),
  data: z.unknown().optional(),
  error: OptionalText,
  method: OptionalText,
  url: OptionalText,
  instructions: OptionalText,
  title: OptionalText,
  message: OptionalText,
});
type Frame = z.infer<typeof FrameSchema>;

const LoginProvidersSchema = z.object({
  providers: entries(
    z.object({
      id: z.string(),
      name: z.string(),
      available: z.boolean().optional().catch(undefined),
      authenticated: z.boolean(),
    }),
  ),
});

const StoredAccountSchema = z.object({
  credentialId: z.number().int(),
  provider: z.string(),
  label: z.string(),
  type: z.string(),
});
type StoredAccount = z.infer<typeof StoredAccountSchema>;
const LogoutAccountsSchema = z.object({ accounts: entries(StoredAccountSchema) });

const UsageReportSchema = z.object({
  provider: z.string(),
  fetchedAt: EpochMs.nullish(),
  limits: entries(
    z.object({
      id: z.string(),
      label: z.string(),
      window: z.object({ resetsAt: EpochMs.nullish() }).nullish(),
      amount: z.object({ usedFraction: UsedFraction.nullish() }).nullish(),
    }),
  ).nullish(),
  metadata: z.object({ accountId: z.string().nullish(), orgId: z.string().nullish() }).nullish(),
});
type UsageReport = z.infer<typeof UsageReportSchema>;
const UsageSchema = z.object({ reports: entries(UsageReportSchema).nullish() });

const ResetAccountSchema = z.object({
  provider: z.string(),
  credentialId: z.number().int(),
  accountId: z.string().nullish(),
  orgId: z.string().nullish(),
  availableCount: z.number().int(),
  redeemableCount: z.number().int(),
  soonestExpiry: z.string().nullish(),
  unavailableReason: z.string().nullish(),
  /** OMP could not read this login's resets at all. */
  error: z.string().nullish(),
});
type ResetAccount = z.infer<typeof ResetAccountSchema>;
const ResetsSchema = z.object({ accounts: entries(ResetAccountSchema).nullish() });

const HistoryEntrySchema = z.object({
  recordedAt: EpochMs,
  provider: z.string(),
  accountId: z.string().nullish(),
  limitId: z.string(),
  label: z.string(),
  usedFraction: UsedFraction.nullish(),
  resetsAt: EpochMs.nullish(),
});
type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
const HistorySchema = z.object({ entries: entries(HistoryEntrySchema).nullish() });

const ModelsSchema = z.object({
  models: entries(z.object({ kind: z.string(), selector: z.string() })),
});

const BalanceSchema = z.object({
  model: z.string(),
  success: z.object({
    accounts: entries(z.object({ account: z.string(), percent: z.number() })),
  }),
});

/** `omp config list --json`: each setting's `{ value, … }` entry, read only where this module uses it. */
const ConfigSchema = z.record(z.string(), z.unknown());
type Config = z.infer<typeof ConfigSchema>;
const SettingValueSchema = z.object({ value: z.union([z.string(), z.number(), z.boolean()]) });

/** One `auth.accountPolicies` entry. Fields this module does not set are kept as written. */
const AccountPolicySchema = z
  .object({
    provider: z.string(),
    account: z.object({ accountId: z.string(), orgId: z.string().optional() }).passthrough(),
    priority: z.number().optional(),
    reservePct: z.number().optional(),
    reclaimAbovePct: z.number().optional(),
  })
  .passthrough();
type AccountPolicy = z.infer<typeof AccountPolicySchema>;
const PoliciesSchema = z.object({ value: entries(AccountPolicySchema).nullish().default([]) });

/** How OMP's account policies select a login. */
interface AccountKey {
  provider: string;
  accountId: string;
  orgId: string | null;
}

/** Above OMP's default account priority of 0. */
const PREFERRED_PRIORITY = 100;
/** The preferred login takes agents back once it has this much more than its reserve left. */
const RECLAIM_MARGIN_PCT = 15;
const DEFAULT_RESERVE_PCT = 10;

/** What the client may see: the plugin's own messages, never a raw Node error or omp's stderr. */
function publicMessage(error: unknown): string {
  return error instanceof OmpPublicError ? error.message : "omp did not answer";
}

function readOutput<T>(schema: z.ZodType<T>, value: unknown, command: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OmpAccountsError(`${command} gave output the plugin can't read`);
  return parsed.data;
}

async function resolveCommand(): Promise<OmpCommand> {
  const executable = await resolveOmpExecutable();
  if (!executable) throw new OmpAccountsError("The omp command was not found on this host");
  return { executable, env: buildStatefulCommandEnv(currentOmpEnvironment()) };
}

async function runOmp(
  command: OmpCommand,
  args: readonly string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  return runBounded(
    defaultSpawn,
    command.executable,
    args,
    command.env,
    timeoutMs,
    KILL_GRACE_MS,
    MAX_OUTPUT_BYTES,
    tmpdir(),
  );
}

async function runJson<T>(command: OmpCommand, args: readonly string[], schema: z.ZodType<T>) {
  const label = `omp ${args.join(" ")}`;
  const run = await runOmp(command, args);
  if (run.outcome !== "exited" || run.exitCode !== 0 || run.truncated) {
    throw new OmpAccountsError(`${label} failed`);
  }
  let output: unknown;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    output = undefined;
  }
  return readOutput(schema, output, label);
}

/** One short-lived `omp --mode rpc` process, spoken to in JSON lines. */
class OmpRpcProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<
    string,
    { resolve(data: unknown): void; reject(error: Error): void }
  >();
  private nextId = 0;
  private closed = false;
  private killer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    command: OmpCommand,
    private readonly onUiRequest?: (frame: Frame) => void,
  ) {
    this.child = spawn(command.executable, RPC_ARGS, {
      cwd: tmpdir(),
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.resume();
    if (this.child.stdout) {
      createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    }
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => {
      this.closed = true;
      clearTimeout(this.killer);
      const status = code === null ? "" : ` with code ${code}`;
      this.failAll(new OmpAccountsError(`omp exited${status}`));
    });
  }

  /** OMP's answer, still unchecked: callers read it through a schema. */
  request(command: Record<string, unknown>, timeoutMs = RPC_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new OmpAccountsError("omp is no longer running"));
    }
    const id = `paseo-omp-${++this.nextId}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new OmpAccountsError(`omp did not answer ${String(command.type)} in time`));
    }, timeoutMs);
    this.pending.set(id, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    this.send({ ...command, id });
    return promise;
  }

  send(frame: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
    // A login process that ignores TERM keeps OMP's fixed OAuth callback port.
    this.killer = setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS);
  }

  private receive(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = FrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    const waiter = frame.id ? this.pending.get(frame.id) : undefined;
    if (frame.type === "response" && frame.id && waiter) {
      this.pending.delete(frame.id);
      if (frame.success) waiter.resolve(frame.data);
      else waiter.reject(new OmpAccountsError(frame.error ?? "omp refused the request"));
    } else if (frame.type === "extension_ui_request") {
      this.onUiRequest?.(frame);
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

interface Listing {
  providers: OmpAccountProvider[];
  accounts: StoredAccount[];
}

/** Every login in OMP's store, read through its rpc account commands. */
async function listStoredLogins(command: OmpCommand): Promise<Listing> {
  const rpc = new OmpRpcProcess(command);
  try {
    const answer = await rpc.request({ type: "get_login_providers" });
    const { providers } = readOutput(LoginProvidersSchema, answer, "omp get_login_providers");
    const lists = await Promise.all(
      providers
        .filter((provider) => provider.authenticated)
        .map(async (provider) => {
          // One provider's failed or odd answer leaves out only that provider's logins.
          const answer = await rpc
            .request({ type: "get_logout_accounts", providerId: provider.id })
            .catch(() => undefined);
          const listed = LogoutAccountsSchema.safeParse(answer);
          return listed.success ? listed.data.accounts : [];
        }),
    );
    // Login aliases (`openai-codex-device`) list the same credentials as their target.
    const accounts = new Map<string, StoredAccount>();
    for (const account of lists.flat()) {
      accounts.set(`${account.provider}/${account.credentialId}`, account);
    }
    return {
      providers: providers
        .filter((provider) => provider.available !== false)
        .map(({ id, name, authenticated }) => ({ id, name, authenticated })),
      accounts: [...accounts.values()],
    };
  } finally {
    rpc.close();
  }
}

function toLimits(report: UsageReport | undefined): OmpAccountLimit[] {
  return (report?.limits ?? []).flatMap((limit) => {
    const usedFraction = limit.amount?.usedFraction;
    if (typeof usedFraction !== "number") return [];
    return [
      { id: limit.id, label: limit.label, usedFraction, resetsAt: limit.window?.resetsAt ?? null },
    ];
  });
}

interface RecordedUsage {
  limits: OmpAccountLimit[];
  at: number;
}

/** The newest recorded reading, for when OMP has no live one (for example the provider refused it). */
function lastRecorded(
  history: readonly HistoryEntry[],
  provider: string,
  accountId: string,
): RecordedUsage | null {
  const rows = history.filter((row) => row.provider === provider && row.accountId === accountId);
  if (rows.length === 0) return null;
  const at = Math.max(...rows.map((row) => row.recordedAt));
  const limits = rows.flatMap((row) => {
    if (row.recordedAt !== at || typeof row.usedFraction !== "number") return [];
    return [
      {
        id: row.limitId,
        label: row.label,
        usedFraction: row.usedFraction,
        resetsAt: row.resetsAt ?? null,
      },
    ];
  });
  return limits.length > 0 ? { limits, at } : null;
}

function toResets(reset: ResetAccount | undefined): OmpAccount["resets"] {
  if (!reset) return null;
  if (reset.error) {
    return {
      available: 0,
      usableNow: false,
      blockedReason: "OMP could not read this login's resets",
      soonestExpiry: null,
    };
  }
  if (reset.availableCount <= 0) return null;
  const usableNow = reset.redeemableCount > 0;
  return {
    available: reset.availableCount,
    usableNow,
    blockedReason: usableNow
      ? null
      : `OMP can't use a reset on this login right now (${reset.unavailableReason ?? "not redeemable"})`,
    soonestExpiry: reset.soonestExpiry ?? null,
  };
}

/** The ids OMP's account policies select this login by; only known for logins with a reset listing. */
function accountKey(reset: ResetAccount | undefined): AccountKey | null {
  return reset?.accountId
    ? { provider: reset.provider, accountId: reset.accountId, orgId: reset.orgId ?? null }
    : null;
}

function selects(policy: AccountPolicy, key: AccountKey): boolean {
  return (
    policy.provider === key.provider &&
    policy.account.accountId === key.accountId &&
    (policy.account.orgId ?? null) === key.orgId
  );
}

function steeringOf(policies: readonly AccountPolicy[], key: AccountKey): OmpAccountSteering {
  const policy = policies.find((entry) => selects(entry, key));
  return {
    preferred: policy?.priority === PREFERRED_PRIORITY,
    reservePct: policy?.reservePct ?? null,
  };
}

interface SteeringChange {
  preferred?: boolean;
  reservePct?: number | null;
}

/**
 * The policy list with `change` applied to the login `key` names. Other logins' policies are kept
 * as written, except that at most one login per provider carries the plugin's preference. A policy
 * left with nothing but its account is dropped, so OMP's config does not collect empty entries.
 */
export function applySteering(
  policies: readonly AccountPolicy[],
  key: AccountKey,
  change: SteeringChange,
  defaultReservePct: number,
): AccountPolicy[] {
  const next = policies.map((policy) => ({ ...policy, account: { ...policy.account } }));
  let target = next.find((policy) => selects(policy, key));
  if (!target) {
    target = {
      provider: key.provider,
      account: { accountId: key.accountId, ...(key.orgId ? { orgId: key.orgId } : {}) },
    };
    next.push(target);
  }
  if (change.preferred === true) {
    for (const policy of next) {
      if (policy.provider === key.provider && policy.priority === PREFERRED_PRIORITY) {
        delete policy.priority;
        delete policy.reclaimAbovePct;
      }
    }
    target.priority = PREFERRED_PRIORITY;
  } else if (change.preferred === false && target.priority === PREFERRED_PRIORITY) {
    delete target.priority;
    delete target.reclaimAbovePct;
  }
  if (change.reservePct === null) delete target.reservePct;
  else if (typeof change.reservePct === "number") target.reservePct = change.reservePct;
  return next
    .map((policy) =>
      policy.provider === key.provider
        ? withReclaimThresholds([policy], defaultReservePct)[0]
        : policy,
    )
    .filter(
      (policy): policy is AccountPolicy => policy !== undefined && Object.keys(policy).length > 2,
    );
}

/**
 * The plugin's preferred policies with their reclaim threshold recomputed above the reserve that
 * applies; OMP refuses a threshold at or below it. Policies the plugin did not prefer are untouched.
 */
export function withReclaimThresholds(
  policies: readonly AccountPolicy[],
  defaultReservePct: number,
): AccountPolicy[] {
  return policies.map((policy) => {
    if (policy.priority !== PREFERRED_PRIORITY) return policy;
    const next = { ...policy };
    const reserve = policy.reservePct ?? defaultReservePct;
    if (reserve < 100) next.reclaimAbovePct = Math.min(100, reserve + RECLAIM_MARGIN_PCT);
    else delete next.reclaimAbovePct;
    return next;
  });
}

function sameKey(a: AccountKey, b: AccountKey): boolean {
  return a.provider === b.provider && a.accountId === b.accountId && a.orgId === b.orgId;
}

function readPolicies(config: Config | null): AccountPolicy[] {
  const parsed = PoliciesSchema.safeParse(config?.["auth.accountPolicies"]);
  return parsed.success ? (parsed.data.value ?? []) : [];
}

function readSettings(config: Config): OmpAccountsSettings {
  const settings: OmpAccountsSettings = {};
  for (const path of OMP_ACCOUNTS_SETTING_PATHS) {
    const entry = SettingValueSchema.safeParse(config[path]);
    if (entry.success) settings[path] = entry.data.value;
  }
  return settings;
}

/**
 * Pairs each OAuth login with its usage report. Reports carry no credential id, so the match goes
 * through the account id OMP's reset listing gives per credential; a provider with one login and
 * one report needs no id. Without a live report, the newest recorded reading stands in.
 */
export function joinAccounts(
  stored: readonly StoredAccount[],
  reports: readonly UsageReport[],
  resets: readonly ResetAccount[],
  history: readonly HistoryEntry[],
  policies: readonly AccountPolicy[],
): OmpAccount[] {
  const accounts = stored.map((login): OmpAccount => {
    if (login.type !== "oauth") {
      return {
        provider: login.provider,
        credentialId: login.credentialId,
        oauth: false,
        label: login.label,
        limits: [],
        usageAt: null,
        usageIsRecorded: false,
        resets: null,
        steering: null,
      };
    }
    const reset = resets.find(
      (entry) => entry.provider === login.provider && entry.credentialId === login.credentialId,
    );
    const candidates = reports.filter((report) => report.provider === login.provider);
    const siblings = stored.filter(
      (other) => other.type === "oauth" && other.provider === login.provider,
    );
    const sameIdentity = (report: UsageReport) =>
      report.metadata?.accountId === reset?.accountId &&
      (!reset?.orgId || !report.metadata?.orgId || report.metadata.orgId === reset.orgId);
    const onlyCandidate =
      siblings.length === 1 && candidates.length === 1 ? candidates[0] : undefined;
    const report = reset?.accountId ? candidates.find(sameIdentity) : onlyCandidate;
    const key = accountKey(reset);
    const live = toLimits(report);
    const recorded =
      live.length === 0 && reset?.accountId
        ? lastRecorded(history, login.provider, reset.accountId)
        : null;
    return {
      provider: login.provider,
      credentialId: login.credentialId,
      oauth: true,
      label: login.label,
      limits: recorded?.limits ?? live,
      usageAt: recorded?.at ?? report?.fetchedAt ?? null,
      usageIsRecorded: recorded !== null,
      resets: toResets(reset),
      steering: key ? steeringOf(policies, key) : null,
    };
  });
  return accounts.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.credentialId - b.credentialId,
  );
}

/** Where new sessions would go right now, by OMP's own balancer. */
async function previewBalance(
  command: OmpCommand,
  provider: string,
): Promise<OmpBalancePreview | null> {
  // Any chat model of the provider spreads over the same logins; OMP names the real selector.
  const listed = await runJson(command, ["models", provider, "--json"], ModelsSchema).catch(
    () => null,
  );
  const model = listed?.models.find((entry) => entry.kind === "chat")?.selector;
  if (!model) return null;
  // An answer without `success` (OMP could not balance) just leaves the line out.
  const result = await runJson(
    command,
    ["dry-balance", model, "--count", BALANCE_SAMPLES, "--json"],
    BalanceSchema,
  ).catch(() => null);
  if (!result) return null;
  return {
    provider,
    model: result.model,
    shares: result.success.accounts.map((share) => ({
      label: share.account,
      percent: share.percent,
    })),
  };
}

interface Snapshot {
  providers: OmpAccountProvider[];
  accounts: OmpAccount[];
  balance: OmpBalancePreview[];
  settings: OmpAccountsSettings;
  /** `provider/credentialId` to the ids OMP's account policies select that login by. */
  identities: Map<string, AccountKey>;
  fetchedAt: number;
  error: string | null;
}

async function readSnapshot(command: OmpCommand, invalidate: boolean): Promise<Snapshot> {
  // Asks the providers again instead of answering from OMP's usage cache.
  if (invalidate) await runOmp(command, ["usage", "invalidate"]);
  const errors: string[] = [];
  const [listing, usage, resets, history, config] = await Promise.all([
    listStoredLogins(command),
    runJson(command, ["usage", "--json"], UsageSchema).catch((error: unknown) => {
      errors.push(`Usage: ${publicMessage(error)}`);
      return { reports: [] };
    }),
    runJson(command, ["usage", "reset", "--json"], ResetsSchema).catch((error: unknown) => {
      errors.push(`Resets: ${publicMessage(error)}`);
      return { accounts: [] };
    }),
    // Local records only, so it is cheap; it stands in for a missing live reading.
    runJson(command, ["usage", "--history", "--json", "--days", "1"], HistorySchema).catch(() => ({
      entries: [],
    })),
    runJson(command, ["config", "list", "--json"], ConfigSchema).catch((error: unknown) => {
      errors.push(`Settings: ${publicMessage(error)}`);
      return null;
    }),
  ]);
  const policies = readPolicies(config);
  const accounts = joinAccounts(
    listing.accounts,
    usage.reports ?? [],
    resets.accounts ?? [],
    history.entries ?? [],
    policies,
  );
  const crowded = [...new Set(accounts.map((account) => account.provider))].filter(
    (provider) => accounts.filter((account) => account.provider === provider).length > 1,
  );
  const previews = await Promise.all(crowded.map((provider) => previewBalance(command, provider)));
  return {
    providers: listing.providers,
    accounts,
    balance: previews.filter((preview): preview is OmpBalancePreview => preview !== null),
    settings: config ? readSettings(config) : {},
    identities: new Map(
      (resets.accounts ?? []).flatMap((reset) => {
        const key = accountKey(reset);
        return key ? [[`${reset.provider}/${reset.credentialId}`, key] as const] : [];
      }),
    ),
    fetchedAt: Date.now(),
    error: errors.length > 0 ? errors.join(" · ") : null,
  };
}

interface LoginState {
  id: string;
  storeKey: string;
  provider: string;
  step: OmpLoginStep;
  url: string | null;
  instructions: string | null;
  codePrompt: string | null;
  message: string | null;
  /** The pending `input` request OMP wants the pasted code for. */
  promptId: string | null;
  process: OmpRpcProcess | null;
  endedAt: number | null;
}

function isOpen(step: OmpLoginStep): boolean {
  return step === "starting" || step === "waiting" || step === "verifying";
}

function toLogin(login: LoginState): OmpLogin {
  return {
    id: login.id,
    provider: login.provider,
    step: login.step,
    url: login.url,
    instructions: login.instructions,
    codePrompt: login.codePrompt,
    message: login.message,
  };
}

function storeKey(store: OmpStore | undefined): string {
  return JSON.stringify(store ?? {});
}

function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * Exposes OMP's own multi-account store. OMP balances its agents across these logins and moves off
 * one that hits a limit by itself, so this only lists, adds, removes and resets them.
 */
export class OmpAccounts {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly loading = new Map<string, Promise<Snapshot>>();
  private readonly logins = new Map<string, LoginState>();
  /** One config write at a time, so each one edits the list the previous one wrote. */
  private readonly writes = new SerialMutationQueue();

  async list(store: OmpStore | undefined, refresh: boolean): Promise<OmpAccountsView> {
    const executable = await resolveOmpExecutable();
    if (!executable) return this.view(store, null, null);
    const key = storeKey(store);
    const cached = this.snapshots.get(key);
    const fresh = cached && Date.now() - cached.fetchedAt < SNAPSHOT_TTL_MS;
    if (fresh && !refresh) return this.view(store, cached, null);
    try {
      return this.view(store, await this.load(store, refresh), null);
    } catch (error) {
      return this.view(
        store,
        cached ?? null,
        `Could not read OMP's accounts: ${publicMessage(error)}`,
      );
    }
  }

  async startLogin(store: OmpStore | undefined, provider: string): Promise<OmpLogin> {
    const command = await resolveCommand();
    // OAuth callbacks listen on fixed local ports, so only one sign-in runs at a time.
    for (const other of this.logins.values()) {
      if (isOpen(other.step)) this.settle(other, "canceled", "A newer sign-in replaced this one");
    }
    for (const [id, login] of this.logins) {
      if (login.endedAt !== null && Date.now() - login.endedAt > FINISHED_LOGIN_TTL_MS) {
        this.logins.delete(id);
      }
    }
    const login: LoginState = {
      id: randomUUID(),
      storeKey: storeKey(store),
      provider,
      step: "starting",
      url: null,
      instructions: null,
      codePrompt: null,
      message: null,
      promptId: null,
      process: null,
      endedAt: null,
    };
    this.logins.set(login.id, login);
    void this.runLogin(login, command, store);
    return toLogin(login);
  }

  submitCode(loginId: string, code: string): OmpLogin {
    const login = this.logins.get(loginId);
    if (!login?.process || !isOpen(login.step)) {
      throw new OmpAccountsError("This sign-in is no longer running. Start it again");
    }
    if (!login.promptId)
      throw new OmpAccountsError("OMP isn't waiting for a code for this sign-in");
    login.process.send({ type: "extension_ui_response", id: login.promptId, value: code });
    login.promptId = null;
    login.codePrompt = null;
    login.step = "verifying";
    return toLogin(login);
  }

  cancelLogin(loginId: string): OmpLogin | null {
    const login = this.logins.get(loginId);
    if (!login) return null;
    if (isOpen(login.step)) this.settle(login, "canceled", "Sign-in was canceled");
    return toLogin(login);
  }

  async remove(store: OmpStore | undefined, provider: string, credentialId: number): Promise<void> {
    const command = await resolveCommand();
    const key = this.snapshots.get(storeKey(store))?.identities.get(`${provider}/${credentialId}`);
    const rpc = new OmpRpcProcess(command);
    try {
      await rpc.request({ type: "logout", providerId: provider, credentialId });
    } finally {
      rpc.close();
    }
    // A policy left behind would silently apply to a later login with the same account id.
    if (key) {
      await this.writes.run(async () => {
        const config = await runJson(command, ["config", "list", "--json"], ConfigSchema);
        const kept = readPolicies(config).filter((policy) => !selects(policy, key));
        await this.writeSetting(
          command,
          "auth.accountPolicies",
          kept.length > 0 ? JSON.stringify(kept) : null,
        );
      });
    }
    await this.refreshAfterChange(store);
  }

  async redeem(
    store: OmpStore | undefined,
    provider: string,
    credentialId: number,
  ): Promise<{ ok: boolean; message: string }> {
    const command = await resolveCommand();
    const account = this.snapshots
      .get(storeKey(store))
      ?.accounts.find(
        (entry) => entry.provider === provider && entry.credentialId === credentialId,
      );
    if (account?.resets && !account.resets.usableNow) {
      return { ok: false, message: account.resets.blockedReason ?? "OMP can't use a reset now" };
    }
    const run = await runOmp(
      command,
      ["usage", "reset", `${provider}/${credentialId}`],
      REDEEM_TIMEOUT_MS,
    );
    const used = run.outcome === "exited" && run.exitCode === 0;
    await this.refreshAfterChange(store);
    if (run.outcome === "timeout") {
      return {
        ok: false,
        message: "OMP did not finish in time; check its banked resets before trying again",
      };
    }
    if (!used) return { ok: false, message: "OMP could not use the reset" };
    return { ok: true, message: lastLine(run.stdout) ?? "Reset used" };
  }

  /** Edits the login's entry in OMP's own `auth.accountPolicies`, so terminal `omp` follows it too. */
  async setSteering(
    store: OmpStore | undefined,
    provider: string,
    credentialId: number,
    change: SteeringChange,
  ): Promise<void> {
    const command = await resolveCommand();
    await this.writes.run(async () => {
      const snapshot = this.snapshots.get(storeKey(store)) ?? (await this.load(store, false));
      const key = snapshot.identities.get(`${provider}/${credentialId}`);
      if (!key) {
        throw new OmpAccountsError(
          "OMP doesn't say which account this login belongs to, so its policies can't select it",
        );
      }
      // OMP refuses a policy that matches two stored logins, which would take the provider down.
      const twins = [...snapshot.identities.entries()].filter(
        ([ref, other]) => ref !== `${provider}/${credentialId}` && sameKey(other, key),
      );
      if (twins.length > 0) {
        throw new OmpAccountsError(
          "Two logins share this account id, so a policy for it would be ambiguous",
        );
      }
      const config = await runJson(command, ["config", "list", "--json"], ConfigSchema);
      const reserve = SettingValueSchema.safeParse(config["retry.usageReservePct"]);
      const defaultReserve =
        reserve.success && typeof reserve.data.value === "number"
          ? reserve.data.value
          : DEFAULT_RESERVE_PCT;
      const next = applySteering(readPolicies(config), key, change, defaultReserve);
      await this.writeSetting(
        command,
        "auth.accountPolicies",
        next.length > 0 ? JSON.stringify(next) : null,
      );
    });
    await this.refreshAfterChange(store);
  }

  async setSetting(
    store: OmpStore | undefined,
    path: OmpAccountsSettingPath,
    value: string | number | boolean | null,
  ): Promise<void> {
    const command = await resolveCommand();
    await this.writes.run(async () => {
      // A new default reserve can sit at or above a preferred login's reclaim threshold, which OMP
      // refuses to load, so the thresholds move with it in the same write.
      if (path === "retry.usageReservePct") {
        const config = await runJson(command, ["config", "list", "--json"], ConfigSchema);
        const nextDefault = typeof value === "number" ? value : DEFAULT_RESERVE_PCT;
        const policies = withReclaimThresholds(readPolicies(config), nextDefault);
        await this.writeSetting(
          command,
          "auth.accountPolicies",
          policies.length > 0 ? JSON.stringify(policies) : null,
        );
      }
      await this.writeSetting(command, path, value === null ? null : JSON.stringify(value));
    });
    await this.refreshAfterChange(store);
  }

  /** `omp config set <path> --json -- <json>`, or `config reset` for null; OMP validates the value. */
  private async writeSetting(
    command: OmpCommand,
    path: string,
    json: string | null,
  ): Promise<void> {
    const args =
      json === null ? ["config", "reset", path] : ["config", "set", path, "--json", "--", json];
    const run = await runOmp(command, args);
    if (run.outcome !== "exited" || run.exitCode !== 0) {
      throw new OmpAccountsError(`OMP rejected the change to ${path}`);
    }
  }

  stop(): void {
    for (const login of this.logins.values()) {
      if (isOpen(login.step)) this.settle(login, "canceled", null);
    }
  }

  private view(
    store: OmpStore | undefined,
    snapshot: Snapshot | null,
    error: string | null,
  ): OmpAccountsView {
    const key = storeKey(store);
    return {
      installed: snapshot !== null || error !== null,
      providers: snapshot?.providers ?? [],
      accounts: snapshot?.accounts ?? [],
      logins: [...this.logins.values()].filter((login) => login.storeKey === key).map(toLogin),
      balance: snapshot?.balance ?? [],
      settings: snapshot?.settings ?? {},
      fetchedAt: snapshot?.fetchedAt ?? null,
      error: error ?? snapshot?.error ?? null,
    };
  }

  /** One read at a time per store; an explicit refresh starts a new one even while a poll runs. */
  private load(store: OmpStore | undefined, invalidate: boolean): Promise<Snapshot> {
    const key = storeKey(store);
    const running = this.loading.get(key);
    if (running && !invalidate) return running;
    const startedAt = Date.now();
    const next = resolveCommand()
      .then((command) => readSnapshot(command, invalidate))
      .then((snapshot) => {
        // A read that began before a later write must not overwrite what that write produced.
        const current = this.snapshots.get(key);
        if (!current || current.fetchedAt <= startedAt) this.snapshots.set(key, snapshot);
        return this.snapshots.get(key) ?? snapshot;
      })
      .finally(() => {
        if (this.loading.get(key) === next) this.loading.delete(key);
      });
    this.loading.set(key, next);
    return next;
  }

  /**
   * After a change OMP has already applied: start a fresh read (never one that began before the
   * change), and if it fails drop the cached snapshot so the next read goes to OMP.
   */
  private async refreshAfterChange(store: OmpStore | undefined): Promise<void> {
    const key = storeKey(store);
    try {
      await this.load(store, true);
    } catch {
      this.snapshots.delete(key);
    }
  }

  private async runLogin(
    login: LoginState,
    command: OmpCommand,
    store: OmpStore | undefined,
  ): Promise<void> {
    try {
      const rpc = new OmpRpcProcess(command, (frame) => this.onLoginUiRequest(login, frame));
      if (!isOpen(login.step)) {
        rpc.close();
        return;
      }
      login.process = rpc;
      await rpc.request({ type: "login", providerId: login.provider }, LOGIN_TIMEOUT_MS);
      if (!isOpen(login.step)) return;
      login.step = "verifying";
      login.codePrompt = null;
      // The login is stored once OMP accepts it; a failed refresh must not report it as failed.
      this.settle(login, "done", null);
      await this.refreshAfterChange(store);
    } catch (error) {
      if (isOpen(login.step)) this.settle(login, "failed", publicMessage(error));
    }
  }

  private onLoginUiRequest(login: LoginState, frame: Frame): void {
    if (!isOpen(login.step)) return;
    if (frame.method === "open_url") {
      login.url = frame.url ?? null;
      login.instructions = frame.instructions ?? null;
      login.step = "waiting";
    } else if (frame.method === "input" && frame.id) {
      // Asked again after a paste: OMP did not accept what was pasted.
      if (login.step === "verifying") {
        login.message = "OMP didn't accept that. Paste the code or the full redirect URL again";
      }
      login.promptId = frame.id;
      login.codePrompt = frame.title ?? "Paste the authorization code";
      login.step = "waiting";
    } else if (frame.method === "notify" && frame.message) {
      login.message = frame.message;
    }
  }

  private settle(login: LoginState, step: OmpLoginStep, message: string | null): void {
    login.step = step;
    login.message = message;
    login.codePrompt = null;
    login.promptId = null;
    login.endedAt = Date.now();
    login.process?.close();
    login.process = null;
  }
}
