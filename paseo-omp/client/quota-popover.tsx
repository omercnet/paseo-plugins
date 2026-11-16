import { type PluginButtonContentProps, useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { storeForProvider, storeLabel } from "../shared/omp-store";
import { listOmpQuotas, listOmpSessionAccounts, type OmpSessionAccount } from "../shared/quota";
import { ompStoreKey } from "./omp-store-state";
import {
  type QuotaProviderGroup,
  type QuotaSessionAccountGroup,
  type QuotaSeverity,
  quotaDetailLabel,
  quotaProviderFromSession,
  quotaProviderGroups,
  quotaProviderIconName,
  quotaProviderLabel,
  quotaSessionAccounts,
  quotaSeverityFromFraction,
  sessionPinCommand,
} from "./quota-state";

const QUOTA_POLL_MS = 30_000;

export function QuotaPopover(props: PluginButtonContentProps) {
  const { theme, layout, close } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const session = useAgent(agentId, (agent) => ({
    model: agent.model,
    provider: agent.provider,
    status: agent.status,
  }));
  const currentProvider = quotaProviderFromSession(session?.provider ?? "", session?.model ?? null);
  const store = storeForProvider(session?.provider);
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const loadQuotas = useRpc(listOmpQuotas);
  const loadSessionAccounts = useRpc(listOmpSessionAccounts);
  const quotas = useQuery({
    queryKey: ["paseo-omp", "quotas", ompStoreKey(store)],
    queryFn: () => loadQuotas({ store }),
    enabled: session !== undefined && session !== null,
    refetchInterval: QUOTA_POLL_MS,
  });
  const sessionAccountsKey = ["paseo-omp", "session-accounts", agentId, currentProvider];
  const sessionAccounts = useQuery({
    queryKey: sessionAccountsKey,
    queryFn: () => loadSessionAccounts({ agentId, provider: currentProvider ?? "" }),
    enabled: Boolean(agentId && currentProvider),
    refetchInterval: QUOTA_POLL_MS,
    retry: false,
  });
  const [switching, setSwitching] = useState<number | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  async function switchTo(login: OmpSessionAccount): Promise<void> {
    setSwitching(login.credentialId);
    setSwitchError(null);
    try {
      await paseo.agents.ref(agentId).send(sessionPinCommand(login.credentialId));
      await queryClient.invalidateQueries({ queryKey: sessionAccountsKey });
      close();
    } catch (cause) {
      setSwitchError(cause instanceof Error ? cause.message : "Could not switch the account.");
    } finally {
      setSwitching(null);
    }
  }

  function severityColor(severity: QuotaSeverity): string {
    if (severity === "danger") return theme.colors.statusDanger;
    if (severity === "warning") return theme.colors.statusWarning;
    if (severity === "ok") return theme.colors.statusSuccess;
    return theme.colors.foregroundMuted;
  }

  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 8 : 10, minWidth: layout.compact ? undefined : 260 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      sessionCard: {
        gap: 4,
        padding: layout.compact ? 10 : 12,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      sessionHeading: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "700" as const,
      },
      sessionLabelRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      sessionLabel: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "700" as const,
        flexShrink: 1,
      },
      group: (current: boolean) => ({
        gap: 6,
        padding: layout.compact ? 10 : 12,
        borderRadius: 10,
        borderWidth: current ? 2 : 1,
        borderColor: current ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }),
      groupHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      groupLabel: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "700" as const,
        flex: 1,
      },
      badge: {
        color: theme.colors.accentForeground,
        backgroundColor: theme.colors.accent,
        fontSize: 10,
        fontWeight: "700" as const,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 999,
        overflow: "hidden" as const,
      },
      row: { gap: 3 },
      rowHeader: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      rowLabel: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      rowValue: { fontSize: 12, fontWeight: "600" as const },
      track: {
        height: 5,
        borderRadius: 3,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
      },
      detail: { color: theme.colors.foregroundMuted, fontSize: 11 },
      // Accounts after the first get a divider so each account's limits read as one block.
      account: (first: boolean) => ({
        gap: 6,
        paddingTop: first ? 4 : 10,
        marginTop: first ? 0 : 4,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.border,
      }),
      accountHeading: { flexDirection: "row" as const, alignItems: "center" as const },
      accountLabel: (inUse: boolean) => ({
        color: inUse ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: inUse ? ("700" as const) : ("400" as const),
        flexShrink: 1,
        minWidth: 0,
      }),
      accountSuffix: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 0 },
      tags: { flexDirection: "row" as const, gap: 4, flexShrink: 0 },
      headingTags: { flexDirection: "row" as const, gap: 4, flexShrink: 0, marginLeft: 6 },
      tag: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "600" as const,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      switch: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      switchPressed: { opacity: 0.72 },
      switchDisabled: { opacity: 0.45 },
      switchText: { color: theme.colors.foreground, fontSize: 11, fontWeight: "600" as const },
    }),
    [layout.compact, theme],
  );

  if (!session || quotas.isLoading) return <Text style={styles.muted}>Loading omp quotas…</Text>;
  if (quotas.error) return <Text style={styles.error}>Could not read omp quota state.</Text>;

  const groups = quotaProviderGroups(quotas.data?.quotas ?? [], currentProvider);
  const hasCurrent = groups.some((group) => group.provider === currentProvider);
  const logins = sessionAccounts.data?.accounts ?? [];
  const activeLogin = logins.find((login) => login.active) ?? null;
  const currentAccounts = quotaSessionAccounts(
    groups.find((group) => group.provider === currentProvider)?.accounts ?? [],
    logins,
  );
  const activeAccount = currentAccounts.find((account) => account.inUse) ?? null;

  function renderTags(tags: readonly string[], style: object) {
    return (
      <View style={style}>
        {tags.map((tag) => (
          <Text key={tag} numberOfLines={1} style={styles.tag}>
            {tag}
          </Text>
        ))}
      </View>
    );
  }

  function renderAccount(account: QuotaSessionAccountGroup, index: number) {
    const login = account.login;
    return (
      <View key={account.accountKey} style={styles.account(index === 0)}>
        {account.label ? (
          <View
            accessibilityRole="header"
            accessibilityLabel={[
              account.label,
              account.suffix,
              ...account.tags,
              account.inUse ? "in use by this session" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            style={styles.accountHeading}
          >
            <Text
              numberOfLines={1}
              ellipsizeMode="middle"
              style={styles.accountLabel(account.inUse)}
            >
              {account.label}
            </Text>
            {account.suffix ? (
              <Text style={styles.accountSuffix}>{` · ${account.suffix}`}</Text>
            ) : null}
            {account.tags.length > 0 ? renderTags(account.tags, styles.headingTags) : null}
            {account.inUse ? <Text style={[styles.badge, { marginLeft: 6 }]}>IN USE</Text> : null}
          </View>
        ) : account.tags.length > 0 ? (
          renderTags(account.tags, styles.tags)
        ) : null}
        {account.accountService ? (
          <Text style={styles.detail}>
            {account.accountService === "github" ? "GitHub" : `GHE · ${account.accountHost}`}
          </Text>
        ) : null}
        {account.quotas.map((quota) => {
          const severity = quotaSeverityFromFraction(quota.usedFraction);
          const color = severityColor(severity);
          const pct =
            quota.usedFraction === null ? 0 : Math.min(100, Math.round(quota.usedFraction * 100));
          return (
            <View key={quota.limitId} style={styles.row}>
              <View style={styles.rowHeader}>
                <Text numberOfLines={1} style={styles.rowLabel}>
                  {quota.label}
                </Text>
                <Text style={[styles.rowValue, { color }]}>
                  {quota.usedFraction === null ? "Unknown" : `${pct}%`}
                </Text>
              </View>
              <View style={styles.track}>
                <View style={{ height: "100%", width: `${pct}%`, backgroundColor: color }} />
              </View>
              <Text style={styles.detail}>{quotaDetailLabel(quota)}</Text>
            </View>
          );
        })}
        {login && !account.inUse ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Use ${account.label ?? login.label} for this session`}
            disabled={switching !== null}
            onPress={() => void switchTo(login)}
            style={({ pressed }) => [
              styles.switch,
              pressed ? styles.switchPressed : null,
              switching !== null ? styles.switchDisabled : null,
            ]}
          >
            <Text style={styles.switchText}>
              {switching === login.credentialId ? "Switching…" : "Use for this session"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {activeLogin ? (
        <View
          accessibilityLabel={`This session uses ${activeLogin.label}`}
          style={styles.sessionCard}
        >
          <Text style={styles.sessionHeading}>THIS SESSION USES</Text>
          <View style={styles.sessionLabelRow}>
            <Text numberOfLines={1} ellipsizeMode="middle" style={styles.sessionLabel}>
              {activeAccount?.label ?? activeLogin.label}
            </Text>
            {activeAccount && activeAccount.tags.length > 0
              ? renderTags(activeAccount.tags, styles.tags)
              : null}
          </View>
          <Text style={styles.detail}>{quotaProviderLabel(currentProvider)}</Text>
        </View>
      ) : null}
      {sessionAccounts.error ? (
        // The host wraps handler errors in transport details; only a short notice belongs here.
        <Text style={styles.muted}>Could not read which account this session uses.</Text>
      ) : null}
      {switchError ? <Text style={styles.error}>{switchError}</Text> : null}
      {session.status === "running" && logins.length > 1 ? (
        <Text style={styles.muted}>Switching takes effect after the current turn finishes.</Text>
      ) : null}
      <Text style={styles.muted}>{storeLabel(store)}</Text>
      <Text style={styles.muted}>
        Last recorded usage from the local agent database, not read live from the provider.
      </Text>
      {currentProvider && !activeLogin ? (
        <Text style={styles.muted}>
          CURRENT PROVIDER identifies the provider, not the account used by this session.
        </Text>
      ) : null}
      {currentProvider && !hasCurrent ? (
        <Text style={styles.muted}>
          {`No recorded quota yet for ${quotaProviderLabel(currentProvider)} (this session's provider).`}
        </Text>
      ) : null}
      {groups.length === 0 ? (
        <Text style={styles.muted}>No provider quota data available.</Text>
      ) : null}
      {groups.map((group: QuotaProviderGroup) => {
        const current = group.provider === currentProvider;
        const accounts: QuotaSessionAccountGroup[] = current
          ? currentAccounts
          : group.accounts.map((account) => ({ ...account, login: null, inUse: false }));
        return (
          <View key={group.provider} style={styles.group(current)}>
            <View style={styles.groupHeader}>
              <Icon
                name={quotaProviderIconName(group.provider)}
                size={16}
                color={severityColor(group.severity)}
              />
              <Text style={styles.groupLabel}>{quotaProviderLabel(group.provider)}</Text>
              <Text style={styles.badge}>{current ? "CURRENT PROVIDER" : "RECORDED"}</Text>
            </View>
            {accounts.map(renderAccount)}
          </View>
        );
      })}
    </View>
  );
}
