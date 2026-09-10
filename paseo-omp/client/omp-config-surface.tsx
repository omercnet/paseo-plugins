import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listOmpConfig, type OmpConfig } from "../shared/omp-config";

const CONFIG_POLL_MS = 30_000;

export interface OmpConfigStyles {
  root: ViewStyle;
  header: ViewStyle;
  headerRow: ViewStyle;
  title: TextStyle;
  source: TextStyle;
  muted: TextStyle;
  error: TextStyle;
  refresh: ViewStyle;
  refreshLabel: TextStyle;
  card: ViewStyle;
  cardTitle: TextStyle;
  row: ViewStyle;
  rowLabel: TextStyle;
  rowValue: TextStyle;
}

function useConfigStyles(theme: PluginSurfaceProps["theme"], compact: boolean): OmpConfigStyles {
  return useMemo(
    () => ({
      root: {
        flex: 1,
        gap: compact ? 10 : 14,
        padding: compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      header: { gap: 4 },
      headerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
      title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "700" },
      source: { color: theme.colors.foregroundMuted, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      refresh: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      refreshLabel: { color: theme.colors.foreground, fontSize: 13 },
      card: {
        gap: 8,
        padding: compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      cardTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
      row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
      rowLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
      rowValue: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
    }),
    [compact, theme],
  );
}

function boolLabel(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : value ? "Yes" : "No";
}

function KeyValueRow({
  styles,
  label,
  value,
}: {
  styles: OmpConfigStyles;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function SectionCard({
  styles,
  title,
  children,
}: {
  styles: OmpConfigStyles;
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ModelRolesSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const roles = Object.entries(config.modelRoles ?? {});
  if (roles.length === 0) return null;
  return (
    <SectionCard styles={styles} title="Model roles">
      {roles.map(([role, model]) => (
        <KeyValueRow key={role} styles={styles} label={role} value={model} />
      ))}
    </SectionCard>
  );
}

function EnabledModelsSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  if (!config.enabledModels || config.enabledModels.length === 0) return null;
  return (
    <SectionCard styles={styles} title="Enabled models">
      {config.enabledModels.map((model) => (
        <Text key={model} style={styles.rowValue}>
          {model}
        </Text>
      ))}
    </SectionCard>
  );
}

function ProvidersSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const hasOrder = !!config.modelProviderOrder?.length;
  const hasDisabled = !!config.disabledProviders?.length;
  if (!hasOrder && !hasDisabled) return null;
  return (
    <SectionCard styles={styles} title="Providers">
      {hasOrder ? (
        <KeyValueRow
          styles={styles}
          label="Order"
          value={(config.modelProviderOrder ?? []).join(" -> ")}
        />
      ) : null}
      {hasDisabled ? (
        <KeyValueRow
          styles={styles}
          label="Disabled"
          value={(config.disabledProviders ?? []).join(", ")}
        />
      ) : null}
    </SectionCard>
  );
}

function RetrySection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const retry = config.retry;
  if (!retry) return null;
  const chains = Object.entries(retry.fallbackChains ?? {});
  return (
    <SectionCard styles={styles} title="Retry and fallback">
      {retry.enabled !== undefined ? (
        <KeyValueRow styles={styles} label="Enabled" value={boolLabel(retry.enabled) ?? ""} />
      ) : null}
      {retry.maxRetries !== undefined ? (
        <KeyValueRow styles={styles} label="Max retries" value={String(retry.maxRetries)} />
      ) : null}
      {retry.modelFallback !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Model fallback"
          value={boolLabel(retry.modelFallback) ?? ""}
        />
      ) : null}
      {retry.usageAwareFallback !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Usage-aware fallback"
          value={boolLabel(retry.usageAwareFallback) ?? ""}
        />
      ) : null}
      {retry.usageReservePct !== undefined ? (
        <KeyValueRow styles={styles} label="Usage reserve" value={`${retry.usageReservePct}%`} />
      ) : null}
      {retry.usageReservePolicy !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Usage reserve policy"
          value={retry.usageReservePolicy}
        />
      ) : null}
      {retry.fallbackRevertPolicy !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Fallback revert policy"
          value={retry.fallbackRevertPolicy}
        />
      ) : null}
      {retry.waitForUsageReset !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Wait for usage reset"
          value={boolLabel(retry.waitForUsageReset) ?? ""}
        />
      ) : null}
      {retry.baseDelayMs !== undefined ? (
        <KeyValueRow styles={styles} label="Base delay" value={`${retry.baseDelayMs}ms`} />
      ) : null}
      {retry.maxDelayMs !== undefined ? (
        <KeyValueRow styles={styles} label="Max delay" value={`${retry.maxDelayMs}ms`} />
      ) : null}
      {chains.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.rowLabel}>Fallback chains</Text>
          {chains.map(([role, chain]) => (
            <KeyValueRow key={role} styles={styles} label={role} value={chain.join(" -> ")} />
          ))}
        </View>
      ) : null}
    </SectionCard>
  );
}

function MemorySection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const backend = config.memory?.backend;
  if (!backend) return null;
  return (
    <SectionCard styles={styles} title="Memory">
      <KeyValueRow styles={styles} label="Backend" value={backend} />
    </SectionCard>
  );
}

function GithubSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const github = config.github;
  if (!github) return null;
  const cacheEnabled = github.cache?.enabled;
  const cacheSoftTtlSec = github.cache?.softTtlSec;
  const cacheHardTtlSec = github.cache?.hardTtlSec;
  return (
    <SectionCard styles={styles} title="GitHub integration">
      {github.enabled !== undefined ? (
        <KeyValueRow styles={styles} label="Enabled" value={boolLabel(github.enabled) ?? ""} />
      ) : null}
      {cacheEnabled !== undefined ? (
        <KeyValueRow styles={styles} label="Cache enabled" value={boolLabel(cacheEnabled) ?? ""} />
      ) : null}
      {cacheSoftTtlSec !== undefined ? (
        <KeyValueRow styles={styles} label="Cache soft TTL" value={`${cacheSoftTtlSec}s`} />
      ) : null}
      {cacheHardTtlSec !== undefined ? (
        <KeyValueRow styles={styles} label="Cache hard TTL" value={`${cacheHardTtlSec}s`} />
      ) : null}
    </SectionCard>
  );
}

function PreferencesSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const themeDark = config.theme?.dark;
  const themeLight = config.theme?.light;
  const { symbolPreset, defaultThinkingLevel } = config;
  const hasAny =
    themeDark !== undefined ||
    themeLight !== undefined ||
    symbolPreset !== undefined ||
    defaultThinkingLevel !== undefined;
  if (!hasAny) return null;
  return (
    <SectionCard styles={styles} title="Theme and preferences">
      {themeDark !== undefined ? (
        <KeyValueRow styles={styles} label="Dark theme" value={themeDark} />
      ) : null}
      {themeLight !== undefined ? (
        <KeyValueRow styles={styles} label="Light theme" value={themeLight} />
      ) : null}
      {symbolPreset !== undefined ? (
        <KeyValueRow styles={styles} label="Symbol preset" value={symbolPreset} />
      ) : null}
      {defaultThinkingLevel !== undefined ? (
        <KeyValueRow styles={styles} label="Default thinking level" value={defaultThinkingLevel} />
      ) : null}
    </SectionCard>
  );
}

function OtherSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const { setupVersion } = config;
  const autoqaConsent = config.dev?.autoqaConsent;
  if (setupVersion === undefined && autoqaConsent === undefined) return null;
  return (
    <SectionCard styles={styles} title="Other">
      {setupVersion !== undefined ? (
        <KeyValueRow styles={styles} label="Setup version" value={String(setupVersion)} />
      ) : null}
      {autoqaConsent !== undefined ? (
        <KeyValueRow styles={styles} label="Auto-QA consent" value={autoqaConsent} />
      ) : null}
    </SectionCard>
  );
}

function isEmptyConfig(config: OmpConfig): boolean {
  return Object.keys(config).length === 0;
}

export function OmpConfigSurface({ theme, layout }: PluginSurfaceProps) {
  const loadConfig = useRpc(listOmpConfig);
  const result = useQuery({
    queryKey: ["paseo-omp", "config"],
    queryFn: () => loadConfig({}),
    refetchInterval: CONFIG_POLL_MS,
  });
  const styles = useConfigStyles(theme, layout.compact);
  const config = result.data?.config ?? null;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>OMP configuration</Text>
          <Pressable
            accessibilityRole="button"
            style={styles.refresh}
            disabled={result.isFetching}
            onPress={() => void result.refetch()}
          >
            <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
            <Text style={styles.refreshLabel}>{result.isFetching ? "Refreshing…" : "Refresh"}</Text>
          </Pressable>
        </View>
        {result.data?.path ? (
          <Text style={styles.source}>{`Source: ${result.data.path}`}</Text>
        ) : null}
      </View>

      {result.isLoading ? <Text style={styles.muted}>Loading OMP configuration…</Text> : null}
      {result.error ? (
        <Text style={styles.error}>Could not read the OMP configuration. Try refreshing.</Text>
      ) : null}
      {!result.isLoading && !result.error && result.data && !result.data.available ? (
        <Text style={styles.muted}>
          No OMP configuration found at this path. It may not have been created yet, or it could not
          be parsed as YAML.
        </Text>
      ) : null}
      {!result.isLoading && !result.error && config && isEmptyConfig(config) ? (
        <Text style={styles.muted}>The OMP configuration has no recognized settings.</Text>
      ) : null}

      {config && !isEmptyConfig(config) ? (
        <>
          <ModelRolesSection styles={styles} config={config} />
          <EnabledModelsSection styles={styles} config={config} />
          <ProvidersSection styles={styles} config={config} />
          <RetrySection styles={styles} config={config} />
          <MemorySection styles={styles} config={config} />
          <GithubSection styles={styles} config={config} />
          <PreferencesSection styles={styles} config={config} />
          <OtherSection styles={styles} config={config} />
        </>
      ) : null}
    </ScrollView>
  );
}
