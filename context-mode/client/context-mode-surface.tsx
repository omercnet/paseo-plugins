import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  type BinaryStatus,
  contextModeSettings,
  getContextModeIntegrationAudit,
  getContextModeStats,
  getContextModeStatus,
  type IntegrationAudit,
} from "../shared";
import { ActionsSection } from "./actions-section";
import { AnalyticsDashboard } from "./analytics-dashboard";
import { KnowledgeSection } from "./knowledge-section";

interface ContextModeSurfaceProps extends PluginSurfaceProps {
  onOpenSettings(): void;
}

function statusLabel(status: BinaryStatus): string {
  if (status.state === "ready") return "Connected";
  if (status.code === "not-installed") return "Not installed";
  if (status.code === "unsupported") return "Unsupported";
  return "Unavailable";
}

type SurfaceTab = "savings" | "knowledge" | "setup";

const SURFACE_TABS: ReadonlyArray<{ id: SurfaceTab; label: string }> = [
  { id: "savings", label: "Savings" },
  { id: "knowledge", label: "Knowledge" },
  { id: "setup", label: "Setup" },
];

export function ContextModeSurface({
  theme,
  host,
  layout,
  onOpenSettings,
}: ContextModeSurfaceProps) {
  const settings = useSettings(contextModeSettings);
  const loadStatus = useRpc(getContextModeStatus);
  const loadStats = useRpc(getContextModeStats);
  const loadIntegrationAudit = useRpc(getContextModeIntegrationAudit);
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SurfaceTab>("savings");
  const readySettings = settings.status === "ready" ? settings : null;
  const refreshInterval = readySettings?.values.refreshIntervalMs ?? 15_000;
  const statusKey = ["context-mode", host.id, "status"] as const;
  const statsKey = ["context-mode", host.id, "stats"] as const;
  const integrationKey = ["context-mode", host.id, "integration"] as const;
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => loadStatus({ fresh: false }),
    refetchInterval: refreshInterval,
    enabled: readySettings !== null,
  });
  const stats = useQuery({
    queryKey: statsKey,
    queryFn: () => loadStats({ fresh: false }),
    refetchInterval: refreshInterval,
    enabled: readySettings !== null && status.data?.state === "ready",
  });
  const integration = useQuery({
    queryKey: integrationKey,
    queryFn: () => loadIntegrationAudit({ fresh: false }),
    refetchInterval: refreshInterval,
    enabled: readySettings !== null,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const nextStatus = await loadStatus({ fresh: true });
      const nextIntegration = await loadIntegrationAudit({ fresh: true });
      const nextStats =
        nextStatus.state === "ready" && nextStatus.supportsStats
          ? await loadStats({ fresh: true })
          : undefined;
      return { nextStatus, nextIntegration, nextStats };
    },
    onSuccess({ nextStatus, nextIntegration, nextStats }) {
      queryClient.setQueryData(statusKey, nextStatus);
      queryClient.setQueryData(integrationKey, nextIntegration);
      if (nextStats) queryClient.setQueryData(statsKey, nextStats);
      void queryClient.invalidateQueries({
        queryKey: ["context-mode", host.id, "analytics-dashboard"],
      });
    },
  });
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 14 : 24,
        gap: layout.compact ? 14 : 20,
        width: "100%" as const,
        maxWidth: 920,
        alignSelf: "center" as const,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      headerCopy: { flex: 1, gap: 2 },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 22 : 28,
        fontWeight: "700" as const,
      },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 13 },
      section: { gap: 8 },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: 15,
        fontWeight: "700" as const,
      },
      card: {
        gap: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        padding: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface1,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      grow: { flex: 1 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, fontSize: 14 },
      success: { color: theme.colors.statusSuccess, fontWeight: "600" as const },
      warning: { color: theme.colors.statusWarning, fontWeight: "600" as const },
      error: { color: theme.colors.statusDanger },
      output: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: layout.compact ? 11 : 12,
        lineHeight: layout.compact ? 16 : 18,
      },
      button: {
        minHeight: 36,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      primaryButton: { backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontWeight: "600" as const },
      primaryButtonText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      healthLine: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      chip: {
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 5,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foreground, fontSize: 11, fontWeight: "600" as const },
      tabRow: {
        flexDirection: "row" as const,
        gap: 6,
        padding: 4,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      tab: {
        flex: 1,
        minHeight: 38,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 8,
        paddingHorizontal: 10,
      },
      tabActive: { backgroundColor: theme.colors.surface2 },
      tabText: { color: theme.colors.foregroundMuted, fontWeight: "600" as const },
      tabTextActive: { color: theme.colors.foreground },
      tabPanel: { width: "100%" as const },
      tabPanelHidden: { display: "none" as const },
    }),
    [layout.compact, theme],
  );

  if (settings.status === "loading") {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.subtitle}>Loading Context Mode settings…</Text>
      </View>
    );
  }

  if (settings.status !== "ready") {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.title}>Context Mode</Text>
        <Text accessibilityRole="alert" style={styles.error}>
          {settings.error}
        </Text>
        <Pressable accessibilityRole="button" onPress={settings.reload} style={styles.button}>
          <Text style={styles.buttonText}>Reload settings</Text>
        </Pressable>
      </View>
    );
  }

  const statusData = status.data;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Icon name="Gauge" size={layout.compact ? 24 : 30} color={theme.colors.accent} />
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Context Mode</Text>
          <Text style={styles.subtitle}>Context saved across your agents on {host.label}</Text>
        </View>
      </View>

      <AnalyticsDashboard
        display="hero"
        fallback={stats.data?.state === "ready" ? stats.data.output : null}
        health={
          <HealthStrip
            audit={integration.data}
            auditError={integration.error}
            auditPending={integration.isPending}
            onOpenSettings={onOpenSettings}
            onRefresh={() => refresh.mutate()}
            refreshError={refresh.error}
            refreshPending={refresh.isPending}
            status={statusData}
            statusError={status.error}
            statusPending={status.isPending}
            styles={styles}
          />
        }
        host={host}
        layout={layout}
        theme={theme}
      />

      <View accessibilityRole="tablist" style={styles.tabRow}>
        {SURFACE_TABS.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab.id)}
              style={[styles.tab, selected ? styles.tabActive : null]}
            >
              <Text style={[styles.tabText, selected ? styles.tabTextActive : null]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.tabPanel, activeTab === "savings" ? null : styles.tabPanelHidden]}>
        <AnalyticsDashboard
          display="details"
          fallback={stats.data?.state === "ready" ? stats.data.output : null}
          host={host}
          layout={layout}
          theme={theme}
        />
      </View>
      <View style={[styles.tabPanel, activeTab === "knowledge" ? null : styles.tabPanelHidden]}>
        <KnowledgeSection key={host.id} host={host} layout={layout} theme={theme} />
      </View>
      <View style={[styles.tabPanel, activeTab === "setup" ? null : styles.tabPanelHidden]}>
        <ActionsSection key={host.id} layout={layout} theme={theme} />
      </View>
    </ScrollView>
  );
}

function HealthStrip({
  audit,
  auditError,
  auditPending,
  onOpenSettings,
  onRefresh,
  refreshError,
  refreshPending,
  status,
  statusError,
  statusPending,
  styles,
}: {
  audit: IntegrationAudit | undefined;
  auditError: unknown;
  auditPending: boolean;
  onOpenSettings(): void;
  onRefresh(): void;
  refreshError: unknown;
  refreshPending: boolean;
  status: BinaryStatus | undefined;
  statusError: unknown;
  statusPending: boolean;
  styles: {
    actions: object;
    button: object;
    buttonText: object;
    card: object;
    chip: object;
    chipText: object;
    error: object;
    grow: object;
    healthLine: object;
    label: object;
    success: object;
    subtitle: object;
    value: object;
    warning: object;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const covered =
    audit?.providers.filter((provider) => provider.activation !== "disabled").length ?? 0;
  const total = audit?.providers.length ?? 0;
  const nativeCount =
    audit?.providers.filter((provider) => provider.activation === "native").length ?? 0;
  const mcpCount = audit?.providers.filter((provider) => provider.activation === "mcp").length ?? 0;
  const statusReady = status?.state === "ready";
  const error = statusError ?? auditError ?? refreshError;

  return (
    <View style={styles.card}>
      <View style={styles.healthLine}>
        {statusPending || auditPending ? <ActivityIndicator size="small" /> : null}
        <Text style={statusReady ? styles.success : styles.warning}>
          {status ? statusLabel(status) : "Checking"}
        </Text>
        {statusReady && status.version ? <Text style={styles.value}>v{status.version}</Text> : null}
        <View style={styles.grow} />
        <Text style={styles.value}>
          {total > 0 ? `${covered} of ${total} providers covered` : "Coverage unavailable"}
        </Text>
      </View>

      {status?.state === "unavailable" ? (
        <Text style={styles.subtitle}>{status.message}</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error instanceof Error ? error.message : String(error)}
        </Text>
      ) : null}
      {statusReady && (!status.supportsDoctor || !status.supportsStats) ? (
        <Text style={styles.warning}>
          Some Context Mode health or savings tools are unavailable.
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{expanded ? "Hide coverage" : "Coverage details"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={refreshPending}
          onPress={onRefresh}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{refreshPending ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onOpenSettings} style={styles.button}>
          <Text style={styles.buttonText}>Settings</Text>
        </Pressable>
      </View>

      {expanded && audit ? (
        <View style={{ gap: 8 }}>
          {mcpCount > 0 ? (
            <Text style={styles.subtitle}>
              MCP coverage applies to new agents. Existing agents may need recreation or manual
              setup.
            </Text>
          ) : null}
          <View style={styles.actions}>
            {audit.providers.map((provider) => (
              <View key={provider.provider} style={styles.chip}>
                <Text style={styles.chipText}>
                  {provider.provider} ·{" "}
                  {provider.activation === "native"
                    ? "Native"
                    : provider.activation === "mcp"
                      ? "MCP · new agents"
                      : "Off"}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.label}>
            {nativeCount} native · {mcpCount} MCP · {total - covered} off
          </Text>
        </View>
      ) : null}
    </View>
  );
}
