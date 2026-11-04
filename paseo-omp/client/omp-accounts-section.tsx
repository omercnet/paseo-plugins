import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  cancelOmpAccountLogin,
  listOmpAccounts,
  type OmpAccount,
  type OmpAccountProvider,
  type OmpAccountsSettingPath,
  type OmpAccountsSettings,
  type OmpAccountsView,
  type OmpLogin,
  redeemOmpAccountReset,
  removeOmpAccount,
  setOmpAccountSteering,
  setOmpAccountsSetting,
  startOmpAccountLogin,
  submitOmpAccountLoginCode,
} from "../shared/omp-accounts";
import { type OmpStore, storeLabel } from "../shared/omp-store";
import { openOmpExternalUrl } from "./external-url";
import {
  accountGroups,
  accountsPollInterval,
  balanceLine,
  loginIsOpen,
  resetsLabel,
  signInProviders,
  usedPercent,
} from "./omp-accounts-state";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";
import { quotaResetLabel, quotaSeverityFromFraction } from "./quota-state";

type Theme = PluginSurfaceProps["theme"];

/** Kept apart from the config editor's `paseo-omp` key so account work never locks setting edits. */
const ACCOUNTS_KEY = ["paseo-omp-accounts"] as const;

type Pending = { kind: "remove"; account: OmpAccount } | { kind: "reset"; account: OmpAccount };

type SignInState =
  | { kind: "pick" }
  | { kind: "starting"; provider: OmpAccountProvider }
  | { kind: "failed"; message: string }
  | { kind: "login"; id: string };

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function accountKey(account: Pick<OmpAccount, "provider" | "credentialId">): string {
  return `${account.provider}/${account.credentialId}`;
}

interface ActionButtonProps {
  styles: OmpConfigStyles;
  theme: Theme;
  label: string;
  onPress(): void;
  tone?: "primary" | "danger";
  disabled?: boolean;
}

export function ActionButton({ styles, theme, label, onPress, tone, disabled }: ActionButtonProps) {
  const dangerBorder = tone === "danger" ? { borderColor: theme.colors.statusDanger } : null;
  const dangerText = tone === "danger" ? { color: theme.colors.statusDanger } : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.editorAction,
        tone === "primary" ? styles.editorActionPrimary : null,
        dangerBorder,
        disabled ? { opacity: 0.5 } : null,
      ]}
    >
      <Text
        style={[
          styles.editorActionText,
          tone === "primary" ? styles.editorActionTextPrimary : null,
          dangerText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function severityColor(theme: Theme, usedFraction: number): string {
  const severity = quotaSeverityFromFraction(usedFraction);
  if (severity === "danger") return theme.colors.statusDanger;
  if (severity === "warning") return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

function UsageBar({
  theme,
  styles,
  limit,
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  limit: OmpAccount["limits"][number];
}) {
  const color = severityColor(theme, limit.usedFraction);
  const percent = usedPercent(limit.usedFraction);
  const resets = quotaResetLabel(limit.resetsAt);
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text numberOfLines={1} style={[styles.rowLabel, { flexShrink: 1 }]}>
          {limit.label}
        </Text>
        <Text style={[styles.rowValue, { color }]}>{`${percent}%`}</Text>
      </View>
      <View
        style={{
          height: 6,
          borderRadius: 3,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        }}
      >
        <View style={{ height: "100%", width: `${percent}%`, backgroundColor: color }} />
      </View>
      {resets ? <Text style={styles.collectionSummary}>{resets}</Text> : null}
    </View>
  );
}

function usageAgeLabel(account: OmpAccount): string | null {
  if (account.usageAt === null || account.limits.length === 0) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - account.usageAt) / 60_000));
  const age = minutes < 1 ? "just now" : `${minutes}m ago`;
  return account.usageIsRecorded ? `OMP's last recorded reading, ${age}` : `Read by OMP ${age}`;
}

/** The reserve select's options; a value outside the fixed choices (set by hand) is listed as itself. */
function reserveOptions(account: OmpAccount, defaultReservePct: number) {
  const current = account.steering?.reservePct ?? null;
  const value = current === null ? "default" : String(current);
  const options = [
    { label: `OMP default (${defaultReservePct}%)`, value: "default" },
    ...RESERVE_CHOICES.map((pct) => ({ label: `${pct}%`, value: pct })),
  ];
  if (current !== null && !RESERVE_CHOICES.some((pct) => pct === value)) {
    options.push({ label: `${value}%`, value });
  }
  return { value, options };
}

function AccountCard({
  account,
  theme,
  styles,
  defaultReservePct,
  saving,
  onRemove,
  onRedeem,
  onSteer,
}: {
  account: OmpAccount;
  theme: Theme;
  styles: OmpConfigStyles;
  defaultReservePct: number;
  /** A steering change is saving; the controls wait for it without unmounting. */
  saving: boolean;
  onRemove(): void;
  onRedeem(): void;
  onSteer(change: { preferred?: boolean; reservePct?: number | null }): void;
}) {
  const reserveShown = reserveOptions(account, defaultReservePct);
  const age = usageAgeLabel(account);
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text numberOfLines={1} style={[styles.cardTitle, { flexShrink: 1 }]}>
          {account.label}
        </Text>
        {account.resets ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{resetsLabel(account.resets)}</Text>
          </View>
        ) : null}
      </View>
      {account.oauth ? null : <Text style={styles.muted}>API key</Text>}
      {account.limits.map((limit) => (
        <UsageBar key={limit.id} theme={theme} styles={styles} limit={limit} />
      ))}
      {account.oauth && account.limits.length === 0 ? (
        <Text style={styles.muted}>OMP has no usage reading for this login yet</Text>
      ) : null}
      {age ? <Text style={styles.collectionSummary}>{age}</Text> : null}
      {account.resets?.blockedReason ? (
        <Text style={styles.collectionSummary}>{account.resets.blockedReason}</Text>
      ) : null}
      {account.steering?.preferred ? (
        <Text style={styles.collectionSummary}>
          Preferred: new agents start here while it has room. OMP can still pick another login, for
          example when it can't read this one's usage.
        </Text>
      ) : null}
      <View style={styles.row}>
        {account.steering ? (
          <ActionButton
            styles={styles}
            theme={theme}
            label={account.steering.preferred ? "Stop preferring" : "Prefer"}
            disabled={saving}
            onPress={() => onSteer({ preferred: !account.steering?.preferred })}
          />
        ) : null}
        {account.resets ? (
          <ActionButton
            styles={styles}
            theme={theme}
            label="Use reset"
            disabled={!account.resets.usableNow}
            onPress={onRedeem}
          />
        ) : null}
        <ActionButton
          styles={styles}
          theme={theme}
          label="Remove"
          tone="danger"
          onPress={onRemove}
        />
      </View>
      {account.steering ? (
        <SettingsSelect
          label="Keep in reserve"
          hint="OMP moves agents off this login before this much is left"
          value={reserveShown.value}
          options={reserveShown.options}
          disabled={saving}
          onValueChange={(choice) =>
            onSteer({ reservePct: choice === "default" ? null : Number(choice) })
          }
        />
      ) : null}
    </View>
  );
}

type SettingRow = {
  path: OmpAccountsSettingPath;
  label: string;
  hint: string;
  options: readonly { label: string; value: string }[];
};

type SteerChange =
  | { kind: "account"; account: OmpAccount; preferred?: boolean; reservePct?: number | null }
  | { kind: "setting"; path: OmpAccountsSettingPath; value: string | number | boolean };

const RESERVE_CHOICES = ["0", "5", "10", "20", "30", "50"] as const;
const KEEP_CHOICES = ["0", "1", "2", "3"] as const;
const REDEEM_WORDS = [
  { label: "Ask before the first one", value: "unset" },
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

/** OMP's own settings for how it uses these logins, worded for the people who use them. */
const SETTING_ROWS: readonly SettingRow[] = [
  {
    path: "retry.usageReservePct",
    label: "Default reserve",
    hint: "Quota OMP keeps unused on each login unless the login sets its own",
    options: RESERVE_CHOICES.map((pct) => ({ label: `${pct}%`, value: pct })),
  },
  {
    path: "retry.usageReservePolicy",
    label: "When every login is down to its reserve",
    hint: "What OMP does once no login has room left above its reserve",
    options: [
      { label: "Ask first", value: "confirm" },
      { label: "Use the reserve", value: "auto" },
      { label: "Stop", value: "fail-closed" },
    ],
  },
  {
    path: "retry.waitForUsageReset",
    label: "When an agent hits a limit",
    hint: "Waiting holds the agent, and its subagents, until the limit resets",
    options: [
      { label: "Wait for the reset", value: "true" },
      { label: "Stop with an error", value: "false" },
    ],
  },
  {
    path: "codexResets.autoRedeem",
    label: "Use banked ChatGPT resets automatically",
    hint: "When an agent is stuck and no other login can take over, and for resets about to expire",
    options: REDEEM_WORDS,
  },
  {
    path: "codexResets.keepCredits",
    label: "ChatGPT resets to keep",
    hint: "Automatic use never goes below this many, except for resets about to expire",
    options: KEEP_CHOICES.map((count) => ({ label: count === "0" ? "None" : count, value: count })),
  },
  {
    path: "claudeResets.autoRedeem",
    label: "Use banked Claude resets automatically",
    hint: "Only for the limits a reset covers",
    options: REDEEM_WORDS,
  },
  {
    path: "claudeResets.keepCredits",
    label: "Claude resets to keep",
    hint: "Automatic use never goes below this many, except for resets about to expire",
    options: KEEP_CHOICES.map((count) => ({ label: count === "0" ? "None" : count, value: count })),
  },
];

/** The select's string back to the type OMP's setting takes. */
function settingValue(row: SettingRow, choice: string): string | number | boolean {
  if (row.path === "retry.waitForUsageReset") return choice === "true";
  if (row.path.endsWith("keepCredits") || row.path === "retry.usageReservePct")
    return Number(choice);
  return choice;
}

/** The current value as a select option; a value outside the fixed choices is listed as itself. */
function withCurrent(row: SettingRow, current: string | number | boolean | undefined) {
  if (current === undefined) return { value: "", options: row.options };
  const value = String(current);
  const known = row.options.some((option) => option.value === value);
  return { value, options: known ? row.options : [...row.options, { label: value, value }] };
}

function SteeringSettingsCard({
  styles,
  settings,
  disabled,
  onChange,
}: {
  styles: OmpConfigStyles;
  settings: OmpAccountsSettings;
  disabled: boolean;
  onChange(path: OmpAccountsSettingPath, value: string | number | boolean): void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.cardTitle}>How OMP uses these logins</Text>
      <Text style={styles.muted}>
        OMP's own settings, written to its config for the selected store. Terminal omp follows them
        too.
      </Text>
      <SettingsCard>
        {SETTING_ROWS.map((row) => {
          const shown = withCurrent(row, settings[row.path]);
          return (
            <SettingsSelect
              key={row.path}
              label={row.label}
              hint={row.hint}
              value={shown.value}
              options={shown.options}
              disabled={disabled || shown.value === ""}
              onValueChange={(choice) => onChange(row.path, settingValue(row, choice))}
            />
          );
        })}
      </SettingsCard>
    </View>
  );
}

export function ConfirmModal({
  styles,
  theme,
  title,
  body,
  confirmLabel,
  tone,
  busy,
  onConfirm,
  onCancel,
}: {
  styles: OmpConfigStyles;
  theme: Theme;
  title: string;
  body: string;
  confirmLabel: string;
  tone: "primary" | "danger";
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Modal title={title} open onOpenChange={(open) => (open || busy ? undefined : onCancel())}>
      <Modal.Content>
        <Text style={styles.rowValue}>{body}</Text>
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <ActionButton
            styles={styles}
            theme={theme}
            label="Cancel"
            disabled={busy}
            onPress={onCancel}
          />
          <ActionButton
            styles={styles}
            theme={theme}
            label={busy ? "Working..." : confirmLabel}
            tone={tone}
            disabled={busy}
            onPress={onConfirm}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function ProviderPicker({
  styles,
  theme,
  providers,
  onPick,
}: {
  styles: OmpConfigStyles;
  theme: Theme;
  providers: readonly OmpAccountProvider[];
  onPick(provider: OmpAccountProvider): void;
}) {
  const [query, setQuery] = useState("");
  const shown = signInProviders(providers, query);
  return (
    <>
      <Text style={styles.muted}>Which provider is the login for?</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search providers"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search providers"
        style={styles.search}
      />
      {shown.length === 0 ? <Text style={styles.muted}>No provider matches</Text> : null}
      {shown.map((provider) => (
        <Pressable
          key={provider.id}
          accessibilityRole="button"
          accessibilityLabel={`Sign in to ${provider.name}`}
          onPress={() => onPick(provider)}
          style={[
            styles.editorAction,
            { flexDirection: "row", justifyContent: "space-between", gap: 8 },
          ]}
        >
          <Text style={[styles.editorActionText, { flexShrink: 1 }]}>{provider.name}</Text>
          {provider.authenticated ? <Text style={styles.collectionSummary}>Signed in</Text> : null}
        </Pressable>
      ))}
    </>
  );
}

/** Owns the pasted text, so it is dropped with the input instead of lingering unseen. */
function CodeEntry({
  placeholder,
  error,
  submitting,
  onSubmit,
}: {
  placeholder: string;
  error: string | null;
  submitting: boolean;
  onSubmit(code: string): void;
}) {
  const [code, setCode] = useState("");
  return (
    <SettingsCard>
      <SettingsInput
        label="Signing in on another device?"
        hint="Paste the address of the page that failed to load after signing in, or the code"
        placeholder={placeholder}
        error={error}
        onChangeText={setCode}
      />
      <SettingsAction
        label="Finish sign-in"
        actionLabel={submitting ? "Continuing..." : "Continue"}
        disabled={submitting || code.trim() === ""}
        onPress={() => onSubmit(code)}
      />
    </SettingsCard>
  );
}

export function LoginProgress({
  styles,
  login,
  onSubmit,
  onRetry,
  onClose,
}: {
  styles: OmpConfigStyles;
  login: Omit<OmpLogin, "provider">;
  onSubmit(code: string): Promise<void>;
  onRetry(): void;
  onClose(): void;
}) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const url = login.url;

  async function submit(code: string) {
    setSubmitting(true);
    setCodeError(null);
    try {
      await onSubmit(code);
    } catch (error) {
      setCodeError(describe(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (login.step === "done") {
    return (
      <SettingsCard>
        <SettingsAction
          label="You're signed in"
          hint="OMP agents on this host can use the login now"
          actionLabel="Done"
          onPress={onClose}
        />
      </SettingsCard>
    );
  }
  if (login.step === "failed" || login.step === "canceled") {
    const failed = login.step === "failed";
    return (
      <SettingsCard>
        <SettingsAction
          label={failed ? "Sign-in did not finish" : "Sign-in was canceled"}
          hint={failed ? undefined : (login.message ?? undefined)}
          error={failed ? (login.message ?? "Sign-in did not finish") : null}
          actionLabel="Try again"
          onPress={onRetry}
        />
      </SettingsCard>
    );
  }
  if (login.step === "starting") return <Text style={styles.muted}>Preparing sign-in...</Text>;
  if (login.step === "verifying") return <Text style={styles.muted}>Checking the login...</Text>;
  return (
    <>
      <SettingsCard>
        <SettingsAction
          label="Open the sign-in page"
          hint={login.instructions ?? "Finish signing in on the page that opens"}
          actionLabel="Open"
          disabled={url === null}
          onPress={() => {
            if (url)
              openOmpExternalUrl(url).catch((error: unknown) => toast.error(describe(error)));
          }}
        />
      </SettingsCard>
      {login.codePrompt ? (
        <CodeEntry
          placeholder={login.codePrompt}
          error={codeError}
          submitting={submitting}
          onSubmit={(code) => void submit(code)}
        />
      ) : (
        <Text style={styles.muted}>Waiting for you to finish signing in...</Text>
      )}
      {login.message ? <Text style={styles.collectionSummary}>{login.message}</Text> : null}
    </>
  );
}

function SignInModal({
  styles,
  theme,
  store,
  view,
  onClose,
}: {
  styles: OmpConfigStyles;
  theme: Theme;
  store: OmpStore | undefined;
  view: OmpAccountsView | undefined;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const start = useRpc(startOmpAccountLogin);
  const submit = useRpc(submitOmpAccountLoginCode);
  const cancel = useRpc(cancelOmpAccountLogin);
  const [state, setState] = useState<SignInState>({ kind: "pick" });
  const closed = useRef(false);
  const login =
    state.kind === "login" ? view?.logins.find((entry) => entry.id === state.id) : undefined;

  async function begin(provider: OmpAccountProvider) {
    setState({ kind: "starting", provider });
    try {
      const started = await start({ store, provider: provider.id });
      // Closed while omp was starting: nothing else knows the id, so cancel it here or it keeps
      // the OAuth callback port until the next sign-in.
      if (closed.current) {
        cancel({ store, loginId: started.id }).catch(() => undefined);
        return;
      }
      setState({ kind: "login", id: started.id });
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    } catch (error) {
      if (!closed.current) setState({ kind: "failed", message: describe(error) });
    }
  }

  function close() {
    closed.current = true;
    if (login && loginIsOpen(login)) cancel({ store, loginId: login.id }).catch(() => undefined);
    onClose();
  }

  let body: ReactNode;
  if (state.kind === "pick") {
    body = (
      <ProviderPicker
        styles={styles}
        theme={theme}
        providers={view?.providers ?? []}
        onPick={(provider) => void begin(provider)}
      />
    );
  } else if (state.kind === "starting") {
    body = <Text style={styles.muted}>{`Starting ${state.provider.name} sign-in...`}</Text>;
  } else if (state.kind === "failed") {
    body = (
      <>
        <Text style={styles.error}>{state.message}</Text>
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <ActionButton styles={styles} theme={theme} label="Close" onPress={close} />
        </View>
      </>
    );
  } else if (login) {
    body = (
      <LoginProgress
        styles={styles}
        login={login}
        onSubmit={async (code) => {
          await submit({ store, loginId: login.id, code });
          await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
        }}
        onRetry={() => setState({ kind: "pick" })}
        onClose={close}
      />
    );
  } else {
    body = <Text style={styles.muted}>Preparing sign-in...</Text>;
  }

  return (
    <Modal title="Add OMP login" open onOpenChange={(open) => (open ? undefined : close())}>
      <Modal.Content>
        <Text style={styles.collectionSummary}>{`Adds the login to ${storeLabel(store)}`}</Text>
        {body}
      </Modal.Content>
    </Modal>
  );
}

export function OmpAccountsSection({
  theme,
  styles,
  store,
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  store?: OmpStore;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const load = useRpc(listOmpAccounts);
  const remove = useRpc(removeOmpAccount);
  const redeem = useRpc(redeemOmpAccountReset);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const setSteering = useRpc(setOmpAccountSteering);
  const setSetting = useRpc(setOmpAccountsSetting);
  const queryKey = [...ACCOUNTS_KEY, ompStoreKey(store)];
  const accounts = useQuery({
    queryKey,
    queryFn: () => load({ store }),
    refetchInterval: (query) => accountsPollInterval(query.state.data),
  });
  const refresh = useMutation({
    mutationKey: [...ACCOUNTS_KEY, "refresh"],
    mutationFn: () => load({ store, refresh: true }),
    onSuccess: (view) => queryClient.setQueryData(queryKey, view),
    onError: (error) => toast.error(describe(error)),
  });
  const removeLogin = useMutation({
    mutationKey: [...ACCOUNTS_KEY, "remove"],
    mutationFn: (account: OmpAccount) =>
      remove({ store, provider: account.provider, credentialId: account.credentialId }),
    onSuccess: async (_result, account) => {
      toast.show(`Signed ${account.label} out of OMP`, { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
    onSettled: () => setPending(null),
  });
  const redeemReset = useMutation({
    mutationKey: [...ACCOUNTS_KEY, "redeem"],
    mutationFn: (account: OmpAccount) =>
      redeem({ store, provider: account.provider, credentialId: account.credentialId }),
    onSuccess: async (result) => {
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
    onSettled: () => setPending(null),
  });
  const steer = useMutation({
    mutationKey: [...ACCOUNTS_KEY, "steer"],
    mutationFn: (change: SteerChange) =>
      change.kind === "account"
        ? setSteering({
            store,
            provider: change.account.provider,
            credentialId: change.account.credentialId,
            preferred: change.preferred,
            reservePct: change.reservePct,
          })
        : setSetting({ store, path: change.path, value: change.value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
    onError: (error) => toast.error(describe(error)),
  });

  const view = accounts.data;
  const groups = view ? accountGroups(view) : [];
  const busy = removeLogin.isPending || redeemReset.isPending;
  const reservePct = view?.settings["retry.usageReservePct"];
  const defaultReserve = typeof reservePct === "number" ? reservePct : 10;

  return (
    <>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Accounts</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh OMP accounts"
            style={styles.refresh}
            disabled={refresh.isPending}
            onPress={() => refresh.mutate()}
          >
            <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
            <Text style={styles.refreshLabel}>
              {refresh.isPending ? "Refreshing..." : "Refresh"}
            </Text>
          </Pressable>
          <ActionButton
            styles={styles}
            theme={theme}
            label="Add login"
            tone="primary"
            disabled={view === undefined || !view.installed}
            onPress={() => setAdding(true)}
          />
        </View>
        <Text style={styles.source}>{storeLabel(store)}</Text>
      </View>
      <Text style={styles.muted}>
        OMP keeps its own sign-ins. It spreads agents across them and moves off a login that hits a
        limit by itself. This page shows those logins and signs them in or out through omp.
      </Text>
      {accounts.isLoading ? <Text style={styles.muted}>Loading OMP accounts...</Text> : null}
      {accounts.error ? (
        <Text
          style={styles.error}
        >{`Could not read OMP's accounts: ${describe(accounts.error)}`}</Text>
      ) : null}
      {view && !view.installed ? (
        <Text style={styles.muted}>The omp command was not found on this host.</Text>
      ) : null}
      {view?.error ? <Text style={styles.error}>{view.error}</Text> : null}
      {view?.installed && view.fetchedAt !== null && groups.length === 0 ? (
        <Text style={styles.muted}>No OMP logins yet. Add one to get started.</Text>
      ) : null}
      {groups.map(({ provider, accounts: logins }) => (
        <View key={provider.id} style={{ gap: 8 }}>
          <Text style={styles.cardTitle}>{provider.name}</Text>
          {view?.balance
            .filter((preview) => preview.provider === provider.id)
            .map((preview) => (
              <Text key={preview.model} style={styles.collectionSummary}>
                {balanceLine(preview)}
              </Text>
            ))}
          {logins.map((account) => (
            <AccountCard
              key={accountKey(account)}
              account={account}
              theme={theme}
              styles={styles}
              defaultReservePct={defaultReserve}
              saving={steer.isPending}
              onRemove={() => setPending({ kind: "remove", account })}
              onRedeem={() => setPending({ kind: "reset", account })}
              onSteer={(change) => steer.mutate({ kind: "account", account, ...change })}
            />
          ))}
        </View>
      ))}
      {view?.installed && view.fetchedAt !== null ? (
        <SteeringSettingsCard
          styles={styles}
          settings={view.settings}
          disabled={steer.isPending}
          onChange={(path, value) => steer.mutate({ kind: "setting", path, value })}
        />
      ) : null}
      {pending?.kind === "remove" ? (
        <ConfirmModal
          styles={styles}
          theme={theme}
          title={`Remove ${pending.account.label}?`}
          body="This signs the login out of OMP on this machine, for the terminal too. OMP agents carry on with its other logins."
          confirmLabel="Remove"
          tone="danger"
          busy={busy}
          onConfirm={() => removeLogin.mutate(pending.account)}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === "reset" ? (
        <ConfirmModal
          styles={styles}
          theme={theme}
          title="Use a banked reset?"
          body={`Spends one banked reset on ${pending.account.label} to refill its limits now. A reset can't be undone.`}
          confirmLabel="Use reset"
          tone="primary"
          busy={busy}
          onConfirm={() => redeemReset.mutate(pending.account)}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {adding ? (
        <SignInModal
          styles={styles}
          theme={theme}
          store={store}
          view={view}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  );
}
