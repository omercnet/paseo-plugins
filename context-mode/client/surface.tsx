import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  type BinaryStatus,
  getContextModeIntegrationAudit,
  getContextModeStatus,
  type IntegrationAudit,
  type ProviderIntegration,
} from "../shared/contracts";
import { contextModeSettings } from "../shared/settings";
import { AnalyticsDashboard } from "./analytics-dashboard";
import {
  ActionButton,
  Card,
  type ChoiceOption,
  Choices,
  ErrorText,
  Pending,
  StatusPill,
  type StatusTone,
} from "./controls";
import { DiagnosticsSection } from "./diagnostics-section";
import { BUILTIN_KNOWLEDGE_PROVIDERS, KnowledgeSection, providerLabel } from "./knowledge-section";
import { ScopedKnowledgeSection } from "./scoped-knowledge-section";
import { parseScreenParams, type ScreenParams, type SurfaceTab } from "./screen-scope";

interface ContextModeSurfaceProps extends PluginSurfaceProps {
  onOpenSettings(): void;
  params?: Record<string, string>;
}

const SURFACE_TABS: readonly ChoiceOption<SurfaceTab>[] = [
  { value: "savings", label: "Savings" },
  { value: "knowledge", label: "Knowledge" },
  { value: "setup", label: "Diagnostics" },
];

interface Presentation {
  label: string;
  tone: StatusTone;
}

const ACTIVATION: Record<ProviderIntegration["activation"], Presentation> = {
  native: { label: "Native", tone: "success" },
  mcp: { label: "MCP, new agents", tone: "success" },
  disabled: { label: "Off", tone: "neutral" },
};

const UNSUPPORTED: Presentation = { label: "Unsupported", tone: "neutral" };

function statusPresentation(status: BinaryStatus): Presentation {
  if (status.state === "ready") return { label: "Connected", tone: "success" };
  if (status.code === "not-installed") return { label: "Not installed", tone: "warning" };
  if (status.code === "unsupported") return { label: "Unsupported", tone: "warning" };
  return { label: "Unavailable", tone: "warning" };
}

/** Providers the panel can search and index for: those Context Mode serves over MCP. */
function supportedProviders(audit: IntegrationAudit | undefined): ProviderIntegration[] {
  if (!audit) return [];
  return audit.providers.filter(({ platform }) => platform !== null);
}

/** Coverage also counts hosts running their own Context Mode, like Pi's extension. */
function coveredProviders(audit: IntegrationAudit | undefined): ProviderIntegration[] {
  if (!audit) return [];
  return audit.providers.filter(
    ({ platform, activation }) => platform !== null || activation === "native",
  );
}

export function ContextModeSurface({
  theme,
  host,
  layout,
  onOpenSettings,
  params,
}: ContextModeSurfaceProps) {
  const settings = useSettings(contextModeSettings);
  const loadStatus = useRpc(getContextModeStatus);
  const loadIntegrationAudit = useRpc(getContextModeIntegrationAudit);
  const queryClient = useQueryClient();
  const toast = useToast();
  const screenParams = parseScreenParams(params ?? {});
  const settingsReady = settings.status === "ready";
  const refreshInterval = settingsReady ? settings.values.refreshIntervalMs : 15_000;
  const statusKey = ["context-mode", host.id, "status"] as const;
  const integrationKey = ["context-mode", host.id, "integration"] as const;
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => loadStatus({ fresh: false }),
    refetchInterval: refreshInterval,
    enabled: settingsReady,
  });
  const integration = useQuery({
    queryKey: integrationKey,
    queryFn: () => loadIntegrationAudit({}),
    refetchInterval: refreshInterval,
    enabled: settingsReady,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const nextStatus = await loadStatus({ fresh: true });
      const nextIntegration = await loadIntegrationAudit({});
      return { nextStatus, nextIntegration };
    },
    onSuccess({ nextStatus, nextIntegration }) {
      queryClient.setQueryData(statusKey, nextStatus);
      queryClient.setQueryData(integrationKey, nextIntegration);
      void queryClient.invalidateQueries({
        queryKey: ["context-mode", host.id, "analytics-dashboard"],
      });
      toast.show("Context Mode status refreshed", { variant: "success" });
    },
  });
  const contentStyle = {
    padding: layout.compact ? 16 : 24,
    gap: layout.compact ? 16 : 24,
    width: "100%" as const,
    maxWidth: 920,
    alignSelf: "center" as const,
  };
  const titleStyle = { color: theme.colors.foreground, fontSize: 20, fontWeight: "500" as const };

  if (settings.status === "loading") return <Loading />;

  if (settings.status !== "ready") {
    return (
      <View style={[{ flex: 1, backgroundColor: theme.colors.surface0 }, contentStyle]}>
        <Text style={titleStyle}>Context Mode</Text>
        <ErrorText theme={theme} error={settings.error} />
        <ActionButton theme={theme} label="Reload settings" onPress={settings.reload} />
      </View>
    );
  }

  const supported = supportedProviders(integration.data).map(({ provider }) => provider);
  const knowledgeProviders = supported.length > 0 ? supported : BUILTIN_KNOWLEDGE_PROVIDERS;
  const paramsKey = JSON.stringify([
    host.id,
    screenParams.section,
    screenParams.agentId,
    screenParams.workspaceId,
  ]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={contentStyle}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Icon name="Gauge" size={24} color={theme.colors.accent} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={titleStyle}>Context Mode</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            Context saved across your agents on {host.label}
          </Text>
        </View>
      </View>

      <AnalyticsDashboard
        display="hero"
        health={
          <HealthStrip
            theme={theme}
            audit={integration.data}
            status={status.data}
            pending={status.isPending || integration.isPending}
            error={status.error ?? integration.error ?? refresh.error}
            refreshing={refresh.isPending}
            onRefresh={() => refresh.mutate()}
            onOpenSettings={onOpenSettings}
          />
        }
        host={host}
        layout={layout}
        theme={theme}
      />

      {/* Keyed by the params so opening the screen with new params selects their section again. */}
      <SurfaceTabs
        key={paramsKey}
        host={host}
        layout={layout}
        theme={theme}
        screenParams={screenParams}
        providers={knowledgeProviders}
        providersLoading={integration.isLoading}
      />
    </ScrollView>
  );
}

interface SurfaceTabsProps extends Pick<PluginSurfaceProps, "host" | "layout" | "theme"> {
  screenParams: ScreenParams;
  providers: readonly string[];
  providersLoading: boolean;
}

function SurfaceTabs({
  host,
  layout,
  theme,
  screenParams,
  providers,
  providersLoading,
}: SurfaceTabsProps) {
  const [activeTab, setActiveTab] = useState<SurfaceTab>(screenParams.section);
  const hidden = { display: "none" as const };
  return (
    <>
      <Choices<SurfaceTab>
        theme={theme}
        role="tab"
        options={SURFACE_TABS}
        value={activeTab}
        onChange={setActiveTab}
        accessibilityLabel={(tab) => tab.label}
      />
      <View style={activeTab === "savings" ? null : hidden}>
        <AnalyticsDashboard display="details" host={host} layout={layout} theme={theme} />
      </View>
      {activeTab === "knowledge" ? (
        <KnowledgePanel
          host={host}
          layout={layout}
          theme={theme}
          screenParams={screenParams}
          providers={providers}
          providersLoading={providersLoading}
        />
      ) : null}
      <View style={activeTab === "setup" ? null : hidden}>
        <DiagnosticsSection key={host.id} theme={theme} />
      </View>
    </>
  );
}

function KnowledgePanel({
  host,
  theme,
  screenParams,
  providers,
  providersLoading,
}: SurfaceTabsProps) {
  if (providersLoading) return <Pending theme={theme} label="Loading providers..." />;
  if (screenParams.agentId || screenParams.workspaceId) {
    return (
      <ScopedKnowledgeSection
        params={screenParams}
        host={host}
        theme={theme}
        providers={providers}
      />
    );
  }
  return <KnowledgeSection key={host.id} host={host} theme={theme} providers={providers} />;
}

function coverageSummary(audit: IntegrationAudit | undefined): string {
  const supported = coveredProviders(audit);
  if (supported.length === 0) return "Coverage unavailable";
  const covered = supported.filter(({ activation }) => activation !== "disabled").length;
  return `${covered} of ${supported.length} providers covered`;
}

interface HealthStripProps {
  theme: PluginTheme;
  audit: IntegrationAudit | undefined;
  status: BinaryStatus | undefined;
  pending: boolean;
  error: unknown;
  refreshing: boolean;
  onRefresh(): void;
  onOpenSettings(): void;
}

function HealthStrip({
  theme,
  audit,
  status,
  pending,
  error,
  refreshing,
  onRefresh,
  onOpenSettings,
}: HealthStripProps) {
  const [expanded, setExpanded] = useState(false);
  const supported = coveredProviders(audit);
  const nativeCount = supported.filter(({ activation }) => activation === "native").length;
  const mcpCount = supported.filter(({ activation }) => activation === "mcp").length;
  const offCount = supported.length - nativeCount - mcpCount;
  const presentation = status ? statusPresentation(status) : null;
  const version = status?.state === "ready" ? status.version : null;
  const valueStyle = { color: theme.colors.foreground, fontSize: 14 };
  const mutedStyle = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    flexWrap: "wrap" as const,
    gap: 8,
  };

  return (
    <Card theme={theme}>
      <View style={rowStyle}>
        {pending ? <Pending theme={theme} label="Checking..." /> : null}
        {presentation ? (
          <StatusPill theme={theme} label={presentation.label} tone={presentation.tone} />
        ) : null}
        {version ? <Text style={valueStyle}>v{version}</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={valueStyle}>{coverageSummary(audit)}</Text>
      </View>

      {status?.state === "unavailable" ? <Text style={mutedStyle}>{status.message}</Text> : null}
      <ErrorText theme={theme} error={error} />

      <View style={rowStyle}>
        <ActionButton
          theme={theme}
          expanded={expanded}
          label={expanded ? "Hide coverage" : "Coverage details"}
          onPress={() => setExpanded((value) => !value)}
        />
        <ActionButton
          theme={theme}
          disabled={refreshing}
          label={refreshing ? "Refreshing..." : "Refresh"}
          onPress={onRefresh}
        />
        <ActionButton theme={theme} label="Settings" onPress={onOpenSettings} />
      </View>

      {expanded && audit ? (
        <View style={{ gap: 8 }}>
          {mcpCount > 0 ? (
            <Text style={mutedStyle}>
              MCP coverage applies to new agents. Existing agents may need recreation or manual
              setup.
            </Text>
          ) : null}
          <View style={rowStyle}>
            {audit.providers.map((provider) => (
              <ProviderCoverage key={provider.provider} provider={provider} theme={theme} />
            ))}
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {nativeCount} native · {mcpCount} MCP · {offCount} off
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

interface ProviderCoverageProps {
  provider: ProviderIntegration;
  theme: PluginTheme;
}

function ProviderCoverage({ provider, theme }: ProviderCoverageProps) {
  const unsupported = provider.platform === null && provider.activation !== "native";
  const activation = unsupported ? UNSUPPORTED : ACTIVATION[provider.activation];
  return (
    <StatusPill
      theme={theme}
      label={`${providerLabel(provider.provider)} · ${activation.label}`}
      tone={activation.tone}
    />
  );
}
