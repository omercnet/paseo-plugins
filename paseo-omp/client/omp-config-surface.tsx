import {
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { copyText, Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import type { ComposerPillSettings } from "../shared/composer-pill-settings";
import { listOmpConfig, type OmpConfig } from "../shared/omp-config";
import { listOmpModels } from "../shared/omp-models";
import {
  categorizeOmpSetting,
  formatOmpSettingLabel,
  isOmpStructuredSettingPath,
  listOmpSettings,
  OMP_SETTING_CATEGORIES,
  type OmpSetting,
  type OmpSettingCategory,
  parseOmpStructuredSettingValue,
  updateOmpSettings,
} from "../shared/omp-settings";
import { type OmpStore, storeLabel } from "../shared/omp-store";
import { getOmpProviderHealth, type OmpProviderHealth } from "../shared/provider-diagnostics";
import { getOmpSupportReport, OMP_SUPPORT_ISSUE_URL } from "../shared/support-diagnostics";
import { ComposerPillSettingsSection } from "./composer-pill-settings";
import { openOmpExternalUrl } from "./external-url";
import { type OmpConfigStyles, useConfigStyles } from "./omp-config-styles";
import { type OmpConfigSurfaceView as SurfaceView, surfaceViewsForScope } from "./omp-config-views";
import {
  documentationForSettingCategory,
  documentationForSettingPath,
  OMP_SETTINGS_GUIDES,
  OMP_SETTINGS_REFERENCE,
  type OmpDocumentationLink,
} from "./omp-doc-links";
import { normalizeOmpModels } from "./omp-model-picker-state";
import { OmpPluginManagerSection } from "./omp-plugin-manager";
import { type OmpModelCatalogState, StructuredRoutingEditor } from "./omp-routing-editor";
import { OmpStorePicker } from "./omp-store-picker";
import { ompStoreKey } from "./omp-store-state";
import {
  type BinaryHealthSummary,
  loadReadyProviderSnapshot,
  lspTone,
  mcpTone,
  type PathStateSummary,
  processTone,
  refreshProviderDiagnostics,
  rpcUiTone,
  selectKnownOmpProviders,
  summarizeBinaryHealth,
  summarizeLspSupport,
  summarizeMcpDiagnostics,
  summarizeMemoryBackend,
  summarizePathState,
  summarizeProcessDiagnostics,
  summarizeProviderStatus,
  summarizeRpcUiSupport,
} from "./provider-diagnostics-state";
import {
  refreshSupportReport,
  type SupportReportCopyState,
  supportDiagnosticsViewState,
} from "./support-diagnostics-state";

const SETTINGS_QUERY_KEY = ["paseo-omp", "settings"] as const;
const CONFIG_POLL_MS = 30_000;
const HEALTH_QUERY_KEY = ["paseo-omp", "provider-health"] as const;
const PROVIDERS_QUERY_KEY = ["paseo-omp", "provider-snapshot"] as const;

function KeyValueRow({
  styles,
  label,
  value,
  valueColor,
}: {
  styles: OmpConfigStyles;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function SectionCard({
  styles,
  title,
  action,
  children,
}: {
  styles: OmpConfigStyles;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

function DocumentationLink({
  link,
  styles,
  onOpen,
}: {
  link: OmpDocumentationLink;
  styles: OmpConfigStyles;
  onOpen(link: OmpDocumentationLink): void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={link.accessibilityLabel}
      accessibilityHint="Opens in your browser"
      onPress={() => onOpen(link)}
      style={({ pressed }) => [styles.docLink, pressed ? styles.docLinkPressed : null]}
    >
      <Text style={styles.docLinkText}>{link.label}</Text>
    </Pressable>
  );
}

function ProviderSetupSection({ styles }: { styles: OmpConfigStyles }) {
  return (
    <SectionCard styles={styles} title="OMP Plugin">
      <Text style={styles.muted}>
        Launch settings currently come from the active Paseo provider profile.
      </Text>
      <KeyValueRow
        styles={styles}
        label="Per agent"
        value="Model, mode, thinking, MCP servers, and persistence"
      />
      <KeyValueRow
        styles={styles}
        label="Provider profile"
        value="Command, environment, session directory, RPC timeout, role models, and denied tools"
      />
    </SectionCard>
  );
}

function PluginConfigurationSection({ styles }: { styles: OmpConfigStyles }) {
  return (
    <>
      <SectionCard styles={styles} title="OMP Plugin launch options">
        <Text style={styles.muted}>
          Paseo does not expose the effective providerOptions for active launches through the plugin
          API. Configure these values in the provider profile; this tab documents the supported
          contract without claiming defaults are active.
        </Text>
        <KeyValueRow styles={styles} label="Command" value="Executable and argument prefix" />
        <KeyValueRow
          styles={styles}
          label="Inherited environment"
          value="Daemon variable names copied at OMP spawn time"
        />
        <KeyValueRow
          styles={styles}
          label="Explicit environment"
          value="Stored non-secret overrides"
        />
        <KeyValueRow styles={styles} label="Output redaction" value="None or configured values" />
        <KeyValueRow
          styles={styles}
          label="Runtime parameters"
          value="Session directory, RPC timeout, small, slow, and plan models"
        />
        <KeyValueRow styles={styles} label="Denied tools" value="Native OMP tool restrictions" />
      </SectionCard>
      <Text style={styles.muted}>
        Inherited environment configuration stores names only. Values stay in the daemon environment
        and are resolved only when OMP starts.
      </Text>
    </>
  );
}
function toneColor(theme: PluginSurfaceProps["theme"], tone: BinaryHealthSummary["tone"]): string {
  if (tone === "ok") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function BinarySection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  const summary = summarizeBinaryHealth(health.binary);
  return (
    <SectionCard styles={styles} title="omp binary">
      <KeyValueRow
        styles={styles}
        label="Status"
        value={summary.label}
        valueColor={toneColor(theme, summary.tone)}
      />
      {health.binary.resolvedPath ? (
        <KeyValueRow styles={styles} label="Resolved path" value={health.binary.resolvedPath} />
      ) : null}
      {health.binary.processCleanupFailed ? (
        <KeyValueRow
          styles={styles}
          label="Process cleanup"
          value="Timed-out probe did not confirm exit"
          valueColor={theme.colors.statusDanger}
        />
      ) : null}
    </SectionCard>
  );
}

function CapabilitiesSection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  return (
    <SectionCard styles={styles} title="Runtime compatibility">
      <KeyValueRow
        styles={styles}
        label="rpc-ui protocol"
        value={summarizeRpcUiSupport(health.rpcUi)}
        valueColor={toneColor(theme, rpcUiTone(health.rpcUi))}
      />
      <KeyValueRow
        styles={styles}
        label="LSP tool"
        value={summarizeLspSupport(health.lsp)}
        valueColor={toneColor(theme, lspTone(health.lsp))}
      />
      <KeyValueRow
        styles={styles}
        label="MCP"
        value={summarizeMcpDiagnostics(health.mcp)}
        valueColor={toneColor(theme, mcpTone(health.mcp))}
      />
    </SectionCard>
  );
}

function pathValue(path: string, state: PathStateSummary): string {
  return `${path} (${state.label})`;
}

function StorageSection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  const agentRoot = summarizePathState(health.roots.agentRootState);
  const configPath = summarizePathState(health.roots.configState);
  const sessionRoot = summarizePathState(health.roots.sessionRootState);
  const agentDb = summarizePathState(health.databases.agentDbState);
  const historyDb = summarizePathState(health.databases.historyDbState);
  return (
    <SectionCard styles={styles} title="Storage">
      <KeyValueRow
        styles={styles}
        label="Agent root"
        value={pathValue(health.roots.agentRoot, agentRoot)}
        valueColor={toneColor(theme, agentRoot.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="Config file"
        value={pathValue(health.roots.configPath, configPath)}
        valueColor={toneColor(theme, configPath.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="Session root"
        value={pathValue(health.roots.sessionRoot, sessionRoot)}
        valueColor={toneColor(theme, sessionRoot.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="agent.db"
        value={agentDb.label}
        valueColor={toneColor(theme, agentDb.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="history.db"
        value={historyDb.label}
        valueColor={toneColor(theme, historyDb.tone)}
      />
      <KeyValueRow styles={styles} label="Memory backend" value={summarizeMemoryBackend(health)} />
    </SectionCard>
  );
}

function ProcessSection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  return (
    <SectionCard styles={styles} title="Hub metadata">
      <KeyValueRow
        styles={styles}
        label="OMP Hub"
        value={summarizeProcessDiagnostics(health.process)}
        valueColor={toneColor(theme, processTone(health.process))}
      />
    </SectionCard>
  );
}

function ProviderHealthSection({
  theme,
  styles,
  cwd,
  store,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  cwd?: string;
  store?: OmpStore;
}) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const loadHealth = useRpc(getOmpProviderHealth);
  const health = useQuery({
    queryKey: [...HEALTH_QUERY_KEY, ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadHealth({ store, ...(cwd ? { cwd } : {}) }),
  });
  const providers = useQuery({
    queryKey: PROVIDERS_QUERY_KEY,
    queryFn: () => loadReadyProviderSnapshot(paseo.providers),
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const result = await refreshProviderDiagnostics({
        providers: paseo.providers,
        providerIds: [
          ...selectKnownOmpProviders(providers.data?.entries ?? []).map((provider) => provider.id),
          ...(store?.profile ? [`omp-plugin-${store.profile}`] : []),
        ],
        loadForcedHealth: () => loadHealth({ store, force: true, ...(cwd ? { cwd } : {}) }),
        cacheHealth: (value) =>
          queryClient.setQueryData(
            [...HEALTH_QUERY_KEY, ompStoreKey(store), cwd ?? "global"],
            value,
          ),
        cacheProviders: (value) => queryClient.setQueryData(PROVIDERS_QUERY_KEY, value),
      });
      if (result.failed) throw new Error("Could not fully refresh OMP provider health.");
    },
  });
  const isRefreshing = refresh.isPending || health.isFetching || providers.isFetching;
  const knownProviders = providers.data ? selectKnownOmpProviders(providers.data.entries) : [];

  return (
    <>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Provider health</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh OMP provider health"
            style={styles.refresh}
            disabled={isRefreshing}
            onPress={() => refresh.mutate()}
          >
            <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
            <Text style={styles.refreshLabel}>{isRefreshing ? "Refreshing…" : "Refresh"}</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.muted}>
        Binary probes run from {cwd ? "this workspace" : "the daemon working directory"}.
        Configuration, storage, MCP, and databases use {storeLabel(store)}. Hub metadata remains
        shared across profiles.
      </Text>

      {health.isLoading ? <Text style={styles.muted}>Checking the omp installation…</Text> : null}
      {health.error ? (
        <Text style={styles.error}>Could not check the omp installation. Try refreshing.</Text>
      ) : null}
      {refresh.error ? (
        <Text style={styles.error}>Could not fully refresh provider health. Try again.</Text>
      ) : null}
      {health.data ? <BinarySection theme={theme} styles={styles} health={health.data} /> : null}
      {health.data ? (
        <CapabilitiesSection theme={theme} styles={styles} health={health.data} />
      ) : null}
      {health.data ? <StorageSection theme={theme} styles={styles} health={health.data} /> : null}
      {health.data ? <ProcessSection theme={theme} styles={styles} health={health.data} /> : null}

      {providers.isLoading ? <Text style={styles.muted}>Loading provider status…</Text> : null}
      {providers.error ? (
        <Text style={styles.error}>Could not load provider status. Try refreshing.</Text>
      ) : null}
      {providers.data && knownProviders.length === 0 ? (
        <Text style={styles.muted}>No OMP provider entries reported yet.</Text>
      ) : null}
      {knownProviders.length > 0 ? (
        <SectionCard styles={styles} title="Registered providers">
          {knownProviders.map((provider) => {
            const status = summarizeProviderStatus(provider);
            return (
              <KeyValueRow
                key={provider.id}
                styles={styles}
                label={provider.label}
                value={status.label}
                valueColor={toneColor(theme, status.tone)}
              />
            );
          })}
        </SectionCard>
      ) : null}
    </>
  );
}

function SupportDiagnosticsSection({
  theme,
  styles,
  cwd,
  store,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  cwd?: string;
  store?: OmpStore;
}) {
  const loadReport = useRpc(getOmpSupportReport);
  const queryClient = useQueryClient();
  const context = { store, ...(cwd ? { cwd } : {}) };
  const queryKey = ["paseo-omp", "support-report", ompStoreKey(store), cwd ?? "global"];
  const report = useQuery({
    queryKey,
    queryFn: () => loadReport(context),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const refreshReport = useMutation({
    mutationFn: () => refreshSupportReport(loadReport, context),
    onSuccess: (value) => queryClient.setQueryData(queryKey, value),
  });
  const [copyState, setCopyState] = useState<SupportReportCopyState>("idle");
  const [linkError, setLinkError] = useState(false);
  const viewState = supportDiagnosticsViewState({
    loading: report.isLoading,
    refreshing: refreshReport.isPending || (report.isFetching && !report.isLoading),
    hasReport: Boolean(report.data?.report),
    reportFailed: Boolean(report.error || refreshReport.error),
    copyState,
  });

  const refresh = () => {
    setCopyState("idle");
    refreshReport.mutate();
  };
  const copyReport = async () => {
    if (!report.data?.report) return;
    setCopyState("copying");
    try {
      await copyText(report.data.report);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Support diagnostics</Text>
        <Text style={styles.muted}>
          Safe OMP runtime, compatibility, storage-state, and protocol counters for maintainers.
        </Text>
      </View>
      <View style={styles.helpActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh OMP support report"
          disabled={report.isFetching || refreshReport.isPending}
          onPress={refresh}
          style={styles.refresh}
        >
          <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
          <Text style={styles.refreshLabel}>{viewState.refreshLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy OMP support report"
          disabled={viewState.copyDisabled}
          onPress={() => void copyReport()}
          style={[styles.refresh, viewState.copyDisabled ? { opacity: 0.55 } : null]}
        >
          <Icon name="Copy" size={14} color={theme.colors.foreground} />
          <Text style={styles.refreshLabel}>{viewState.copyLabel}</Text>
        </Pressable>
        <ExternalLink
          href={OMP_SUPPORT_ISSUE_URL}
          accessibilityLabel="Create paseo-omp GitHub issue"
          onError={() => setLinkError(true)}
        >
          <Text style={styles.helpLinkText}>Create GitHub issue</Text>
        </ExternalLink>
      </View>
      <Text style={styles.muted}>
        Review before sharing. The report excludes prompts, transcripts, credentials, commands,
        URLs, repository names, and private paths.
      </Text>
      {viewState.loadingMessage ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {viewState.loadingMessage}
        </Text>
      ) : null}
      {viewState.reportError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {viewState.reportError}
        </Text>
      ) : null}
      {viewState.copyFeedback ? (
        <Text
          accessibilityLiveRegion="polite"
          style={copyState === "error" ? styles.error : styles.muted}
        >
          {viewState.copyFeedback}
        </Text>
      ) : null}
      {linkError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not open GitHub. Copy the report and open the issue tracker manually.
        </Text>
      ) : null}
      {report.data?.report ? (
        <View style={styles.helpReport}>
          <Text selectable style={styles.helpReportText}>
            {report.data.report}
          </Text>
        </View>
      ) : null}
    </>
  );
}

const CATEGORY_LABELS: Record<OmpSettingCategory, string> = {
  appearance: "Appearance",
  model: "Model",
  interaction: "Interaction",
  context: "Context",
  memory: "Memory",
  files: "Files",
  shell: "Shell",
  tools: "Tools",
  tasks: "Tasks",
  providers: "Providers",
  general: "General",
};

const CONFIG_CATEGORIES = OMP_SETTING_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] }));

function fallbackSettingsFromConfig(config: OmpConfig | null | undefined): OmpSetting[] {
  if (!config) return [];
  const settings: OmpSetting[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      settings.push({ path, type: "array", value, description: "" });
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        settings.push({ path, type: "record", value, description: "" });
        return;
      }
      for (const [key, nested] of entries) visit(nested, path ? `${path}.${key}` : key);
      return;
    }
    if (typeof value === "boolean") {
      settings.push({ path, type: "boolean", value, description: "" });
    } else if (typeof value === "number") {
      settings.push({ path, type: "number", value, description: "" });
    } else if (typeof value === "string") {
      settings.push({ path, type: "string", value, description: "" });
    }
  };
  visit(config, "");
  return settings;
}

function formatScalarValue(value: unknown): string {
  if (value === undefined || value === null) return "Not set";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const serialized = JSON.stringify(value);
  if (!serialized) return "Not set";
  return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized;
}

function StructuredSettingValue({
  setting,
  styles,
}: {
  setting: OmpSetting;
  styles: OmpConfigStyles;
}) {
  if (setting.redacted) {
    return (
      <Text style={styles.settingValue}>
        {setting.configured === true
          ? "Configured (hidden)"
          : setting.configured === false
            ? "Not set"
            : "Hidden"}
      </Text>
    );
  }
  const value = setting.value;
  if (!Array.isArray(value) && (value === null || typeof value !== "object")) {
    return <Text style={styles.settingValue}>{formatScalarValue(value)}</Text>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={styles.muted}>None</Text>;
    const allScalar = value.every(
      (item) => item === null || ["boolean", "number", "string"].includes(typeof item),
    );
    const occurrences = new Map<string, number>();
    const items = value.map((item) => {
      const text = formatScalarValue(item);
      const occurrence = (occurrences.get(text) ?? 0) + 1;
      occurrences.set(text, occurrence);
      return { item, key: `${text}-${occurrence}`, text };
    });
    return (
      <View style={styles.recordList}>
        <Text style={styles.collectionSummary}>{value.length} items</Text>
        {allScalar ? (
          <View style={styles.chipList}>
            {items.map(({ key, text }) => (
              <View key={key} style={styles.chip}>
                <Text style={styles.chipText}>{text}</Text>
              </View>
            ))}
          </View>
        ) : (
          items.map(({ item, key }, position) => (
            <View key={key} style={styles.recordRow}>
              <Text style={styles.recordKey}>{position + 1}</Text>
              <Text selectable style={styles.recordValue}>
                {formatScalarValue(item)}
              </Text>
            </View>
          ))
        )}
      </View>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <Text style={styles.muted}>None</Text>;
  return (
    <View style={styles.recordList}>
      <Text style={styles.collectionSummary}>{entries.length} entries</Text>
      {entries.map(([key, item]) => (
        <View key={key} style={styles.recordRow}>
          <Text selectable style={styles.recordKey}>
            {key}
          </Text>
          <Text selectable style={styles.recordValue}>
            {formatScalarValue(item)}
          </Text>
        </View>
      ))}
    </View>
  );
}

type SettingDraft = { operation: "set"; value: unknown } | { operation: "reset" };

function EditableScalarValue({
  setting,
  draft,
  disabled,
  resetLabel,
  showReset,
  styles,
  onSet,
  onReset,
}: {
  setting: OmpSetting;
  draft: SettingDraft | undefined;
  disabled: boolean;
  resetLabel: string;
  showReset: boolean;
  styles: OmpConfigStyles;
  onSet(value: string | boolean): void;
  onReset(): void;
}) {
  const value = draft?.operation === "set" ? draft.value : setting.value;
  return (
    <View style={styles.recordList}>
      {draft?.operation === "reset" ? (
        <Text style={styles.muted}>{resetLabel} when changes are applied</Text>
      ) : setting.type === "boolean" ? (
        <Switch
          accessibilityLabel={`Toggle ${formatOmpSettingLabel(setting.path)}`}
          disabled={disabled}
          value={value === true}
          onValueChange={onSet}
        />
      ) : (
        <TextInput
          accessibilityLabel={`Edit ${formatOmpSettingLabel(setting.path)}`}
          editable={!disabled}
          keyboardType={setting.type === "number" ? "numeric" : "default"}
          value={value === undefined ? "" : String(value)}
          onChangeText={onSet}
          style={styles.scalarInput}
        />
      )}
      {showReset ? (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onReset}>
          <Text style={styles.resetAction}>{resetLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ConfigurationCategory({
  category,
  styles,
  settings,
  drafts,
  theme,
  modelCatalog,
  modelRoles,
  disabled,
  workspaceScoped,
  onDraft,
  onOpenDocumentation,
}: {
  category: { id: OmpSettingCategory; label: string };
  styles: OmpConfigStyles;
  theme: PluginSurfaceProps["theme"];
  modelCatalog: OmpModelCatalogState;
  modelRoles: Readonly<Record<string, unknown>>;
  settings: readonly OmpSetting[];
  drafts: Readonly<Record<string, SettingDraft>>;
  disabled: boolean;
  workspaceScoped: boolean;
  onDraft(path: string, draft: SettingDraft): void;
  onOpenDocumentation(link: OmpDocumentationLink): void;
}) {
  const categoryDocumentation = documentationForSettingCategory(category.id);
  return (
    <SectionCard
      styles={styles}
      title={`${category.label} · ${settings.length}`}
      action={
        categoryDocumentation ? (
          <DocumentationLink
            link={categoryDocumentation}
            styles={styles}
            onOpen={onOpenDocumentation}
          />
        ) : undefined
      }
    >
      {settings.map((setting) => {
        const complex =
          Array.isArray(setting.value) ||
          (setting.value !== null && typeof setting.value === "object");
        const editable =
          !setting.redacted && ["boolean", "number", "string", "enum"].includes(setting.type);
        const structuredEditable =
          !setting.redacted &&
          isOmpStructuredSettingPath(setting.path) &&
          setting.type === (setting.path === "cycleOrder" ? "array" : "record");
        const settingDocumentation = documentationForSettingPath(setting.path);
        const draft = drafts[setting.path];
        return (
          <View key={setting.path} style={styles.setting}>
            <View style={styles.settingHeader}>
              <Text style={styles.cardTitle}>{formatOmpSettingLabel(setting.path)}</Text>
              {setting.workspaceOverride ? (
                <Text style={styles.source}>Workspace override</Text>
              ) : null}
              {!complex && !editable && !structuredEditable ? (
                <StructuredSettingValue setting={setting} styles={styles} />
              ) : null}
            </View>
            <Text selectable style={styles.settingPath}>
              {setting.path} · {setting.type}
            </Text>
            {settingDocumentation ? (
              <View style={styles.docsActions}>
                <DocumentationLink
                  link={settingDocumentation}
                  styles={styles}
                  onOpen={onOpenDocumentation}
                />
              </View>
            ) : null}
            {editable ? (
              <EditableScalarValue
                setting={setting}
                draft={draft}
                disabled={disabled}
                resetLabel={workspaceScoped ? "Remove workspace override" : "Reset to default"}
                showReset={!workspaceScoped || setting.workspaceOverride === true}
                styles={styles}
                onSet={(value) => onDraft(setting.path, { operation: "set", value })}
                onReset={() => onDraft(setting.path, { operation: "reset" })}
              />
            ) : structuredEditable ? (
              <StructuredRoutingEditor
                setting={setting}
                value={draft?.operation === "set" ? draft.value : setting.value}
                disabled={disabled}
                resetLabel={workspaceScoped ? "Remove workspace override" : "Reset to default"}
                showReset={!workspaceScoped || setting.workspaceOverride === true}
                resetPending={draft?.operation === "reset"}
                styles={styles}
                theme={theme}
                modelCatalog={modelCatalog}
                modelRoles={modelRoles}
                onSet={(value) => onDraft(setting.path, { operation: "set", value })}
                onReset={() => onDraft(setting.path, { operation: "reset" })}
              />
            ) : complex ? (
              <StructuredSettingValue setting={setting} styles={styles} />
            ) : null}
            {setting.description ? (
              <Text style={styles.settingDescription}>{setting.description}</Text>
            ) : null}
          </View>
        );
      })}
    </SectionCard>
  );
}

function SurfaceTabs({
  styles,
  selected,
  views,
  onSelect,
}: {
  styles: OmpConfigStyles;
  selected: SurfaceView;
  views: readonly { id: SurfaceView; label: string }[];
  onSelect: (view: SurfaceView) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.topTabs}>
      {views.map((view) => {
        const active = selected === view.id;
        return (
          <Pressable
            key={view.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(view.id)}
            style={[styles.topTab, active ? styles.topTabActive : null]}
          >
            <Text style={[styles.topTabLabel, active ? styles.topTabLabelActive : null]}>
              {view.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
function OmpConfigContent({
  theme,
  layout,
  cwd,
  store,
  onStoreChange,
  onComposerPillSettingsChange,
}: PluginSurfaceProps & {
  cwd?: string;
  store?: OmpStore;
  onStoreChange(store: OmpStore | undefined): void;
  onComposerPillSettingsChange?: (settings: ComposerPillSettings) => void;
}) {
  const loadConfig = useRpc(listOmpConfig);
  const loadSettings = useRpc(listOmpSettings);
  const updateSettings = useRpc(updateOmpSettings);
  const loadModels = useRpc(listOmpModels);
  const queryClient = useQueryClient();
  const context = { store, ...(cwd ? { cwd } : {}) };
  const pendingMutations = useIsMutating({ mutationKey: ["paseo-omp"] });
  const configQuery = useQuery({
    queryKey: ["paseo-omp", "config", ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadConfig(context),
    refetchInterval: CONFIG_POLL_MS,
  });
  const settingsQueryKey = [...SETTINGS_QUERY_KEY, ompStoreKey(store), cwd ?? "global"];
  const settingsQuery = useQuery({
    queryKey: settingsQueryKey,
    queryFn: () => loadSettings(context),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const modelsQuery = useQuery({
    queryKey: ["paseo-omp", "models", ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadModels(context),
    staleTime: 30_000,
  });
  const [view, setView] = useState<SurfaceView>("overview");
  const [activeCategory, setActiveCategory] = useState<OmpSettingCategory>("appearance");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, SettingDraft>>({});
  const [documentationError, setDocumentationError] = useState<string | null>(null);
  const styles = useConfigStyles(theme, layout.compact);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const surfaceViews = surfaceViewsForScope(cwd !== undefined);
  const catalog = useMemo(() => {
    const sourceSettings = settingsQuery.data?.available
      ? settingsQuery.data.settings
      : fallbackSettingsFromConfig(configQuery.data?.config);
    const matching = sourceSettings.filter((setting) => {
      if (!normalizedSearch) return true;
      return `${setting.path}\n${setting.description}`
        .toLocaleLowerCase()
        .includes(normalizedSearch);
    });
    const byCategory = new Map<OmpSettingCategory, OmpSetting[]>();
    for (const setting of matching) {
      const category = categorizeOmpSetting(setting.path);
      const group = byCategory.get(category);
      if (group) group.push(setting);
      else byCategory.set(category, [setting]);
    }
    return { sourceSettings, matching, byCategory };
  }, [configQuery.data?.config, normalizedSearch, settingsQuery.data]);
  const modelCatalog: OmpModelCatalogState = {
    models: normalizeOmpModels(modelsQuery.data?.models ?? []),
    loading: modelsQuery.isLoading,
    ...(modelsQuery.error
      ? { error: "Could not list OMP models. Freeform selectors remain available." }
      : {}),
  };
  const modelRolesValue = drafts.modelRoles
    ? drafts.modelRoles.operation === "set"
      ? drafts.modelRoles.value
      : undefined
    : catalog.sourceSettings.find((setting) => setting.path === "modelRoles")?.value;
  const modelRoles =
    modelRolesValue !== null &&
    typeof modelRolesValue === "object" &&
    !Array.isArray(modelRolesValue)
      ? (modelRolesValue as Readonly<Record<string, unknown>>)
      : {};
  const visibleCategories = CONFIG_CATEGORIES.filter(
    (category) => (catalog.byCategory.get(category.id)?.length ?? 0) > 0,
  );
  const selectedCategory =
    visibleCategories.find((category) => category.id === activeCategory) ?? visibleCategories[0];
  const openDocumentation = useCallback(async (link: OmpDocumentationLink) => {
    setDocumentationError(null);
    try {
      await openOmpExternalUrl(link.url);
    } catch {
      setDocumentationError(`Could not open ${link.label.toLocaleLowerCase()}.`);
    }
  }, []);

  const save = useMutation({
    mutationKey: ["paseo-omp", "settings", ompStoreKey(store)],
    mutationFn: async () => {
      const revision = settingsQuery.data?.revision;
      if (!revision) throw new Error("OMP settings cannot be edited without a current revision.");
      const byPath = new Map(catalog.sourceSettings.map((setting) => [setting.path, setting]));
      const changes = Object.entries(drafts).map(([path, draft]) => {
        if (draft.operation === "reset") return { operation: "reset" as const, path };
        const setting = byPath.get(path);
        if (!setting) throw new Error(`Setting ${path} is no longer available.`);
        let value: unknown = draft.value;
        if (isOmpStructuredSettingPath(path)) {
          const parsed = parseOmpStructuredSettingValue(path, value);
          if (parsed === undefined) throw new Error(`${path} contains invalid routing values.`);
          value = parsed;
        } else if (setting.type === "number") {
          const raw = String(draft.value).trim();
          if (!raw) throw new Error(`${path} requires a number.`);
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) throw new Error(`${path} requires a finite number.`);
          value = parsed;
        }
        return { operation: "set" as const, path, value };
      });
      const input = updateOmpSettings.input.parse({ ...context, revision, changes });
      return updateSettings(input);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(settingsQueryKey, result.catalog);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["paseo-omp", "config"] });
      if (
        !result.conflict &&
        !result.failed &&
        result.appliedPaths.length === Object.keys(drafts).length
      ) {
        setDrafts({});
      } else if (result.appliedPaths.length > 0) {
        setDrafts((current) => {
          const next = { ...current };
          for (const path of result.appliedPaths) delete next[path];
          return next;
        });
      }
    },
  });
  const draftCount = Object.keys(drafts).length;
  const workspaceOverrideCount = catalog.sourceSettings.filter(
    (setting) => setting.workspaceOverride,
  ).length;
  const displayedConfigPath = settingsQuery.data?.available
    ? settingsQuery.data.path
    : configQuery.data?.path;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.pageTitle}>{cwd ? "Workspace OMP" : "OMP"}</Text>
      {cwd ? (
        <Text selectable style={styles.muted}>
          Project-scoped view · {cwd}
        </Text>
      ) : null}
      {view !== "composer" ? (
        <>
          <OmpStorePicker
            theme={theme}
            store={store}
            onChange={onStoreChange}
            disabled={pendingMutations > 0}
          />
          <Text style={styles.muted}>
            Switching stores clears unapplied edits and pending confirmations.
          </Text>
        </>
      ) : null}
      <SurfaceTabs styles={styles} selected={view} views={surfaceViews} onSelect={setView} />

      {view === "overview" ? (
        <>
          <ProviderSetupSection styles={styles} />
          {configQuery.isLoading ? (
            <Text style={styles.muted}>Loading the native configuration…</Text>
          ) : configQuery.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              Could not read the native OMP configuration.
            </Text>
          ) : (
            <SectionCard
              styles={styles}
              title={cwd ? "Workspace configuration" : "Native configuration"}
            >
              <KeyValueRow
                styles={styles}
                label="Source"
                value={displayedConfigPath ?? "Source unavailable"}
              />
              {cwd ? (
                <>
                  <KeyValueRow styles={styles} label="Scope" value="Workspace / project" />
                  <KeyValueRow
                    styles={styles}
                    label="Overrides"
                    value={`${workspaceOverrideCount} project-specific settings`}
                  />
                  <Text style={styles.muted}>
                    Settings without a workspace override inherit their effective global or default
                    value.
                  </Text>
                </>
              ) : null}
              <KeyValueRow
                styles={styles}
                label="Status"
                value={configQuery.data?.available ? "Available" : "Unavailable"}
              />
              <KeyValueRow
                styles={styles}
                label="Settings discovered"
                value={String(catalog.sourceSettings.length)}
              />
            </SectionCard>
          )}
        </>
      ) : null}

      {view === "plugin" ? <PluginConfigurationSection styles={styles} /> : null}

      {view === "plugins" ? (
        <OmpPluginManagerSection theme={theme} compact={layout.compact} cwd={cwd} store={store} />
      ) : null}
      {view === "composer" && !cwd && onComposerPillSettingsChange ? (
        <ComposerPillSettingsSection theme={theme} onChange={onComposerPillSettingsChange} />
      ) : null}

      {view === "diagnostics" ? (
        <ProviderHealthSection theme={theme} styles={styles} cwd={cwd} store={store} />
      ) : null}

      {view === "help" ? (
        <SupportDiagnosticsSection theme={theme} styles={styles} cwd={cwd} store={store} />
      ) : null}

      {view === "configuration" ? (
        <>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Configuration</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh OMP configuration"
                style={styles.refresh}
                disabled={
                  configQuery.isFetching || settingsQuery.isFetching || modelsQuery.isFetching
                }
                onPress={() => {
                  void Promise.all([
                    configQuery.refetch(),
                    settingsQuery.refetch(),
                    modelsQuery.refetch(),
                  ]);
                }}
              >
                <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
                <Text style={styles.refreshLabel}>
                  {configQuery.isFetching || settingsQuery.isFetching || modelsQuery.isFetching
                    ? "Refreshing…"
                    : "Refresh"}
                </Text>
              </Pressable>
            </View>
            <View style={styles.docsActions}>
              <DocumentationLink
                link={OMP_SETTINGS_REFERENCE}
                styles={styles}
                onOpen={openDocumentation}
              />
              {OMP_SETTINGS_GUIDES.map((link) => (
                <DocumentationLink
                  key={link.url}
                  link={link}
                  styles={styles}
                  onOpen={openDocumentation}
                />
              ))}
            </View>
            {displayedConfigPath ? (
              <Text style={styles.source}>{`Source: ${displayedConfigPath}`}</Text>
            ) : (
              <Text style={styles.source}>Source unavailable</Text>
            )}
            {cwd ? (
              <Text style={styles.muted}>
                {workspaceOverrideCount} project-specific overrides. All other effective values
                inherit global configuration or OMP defaults. Applying a change creates or updates
                the override in .omp/config.yml; removing an override restores inheritance.
              </Text>
            ) : null}
          </View>
          {documentationError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {documentationError}
            </Text>
          ) : null}

          {draftCount > 0 ? (
            <View style={styles.editorActions}>
              <Text style={styles.muted}>{draftCount} unsaved changes</Text>
              <Pressable
                accessibilityRole="button"
                disabled={save.isPending}
                onPress={() => setDrafts({})}
                style={styles.editorAction}
              >
                <Text style={styles.editorActionText}>Discard</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={save.isPending}
                onPress={() => save.mutate()}
                style={[styles.editorAction, styles.editorActionPrimary]}
              >
                <Text style={[styles.editorActionText, styles.editorActionTextPrimary]}>
                  {save.isPending ? "Applying…" : "Apply changes"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {save.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {save.error instanceof Error ? save.error.message : "Could not apply OMP settings."}
            </Text>
          ) : null}
          {save.data?.conflict ? (
            <Text accessibilityRole="alert" style={styles.error}>
              OMP configuration changed outside Paseo. Review the refreshed values and apply again.
            </Text>
          ) : null}
          {save.data?.failed ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {save.data.failed.path}: {save.data.failed.message}
            </Text>
          ) : null}

          {settingsQuery.isLoading ? (
            <Text style={styles.muted}>Loading the OMP settings catalog…</Text>
          ) : null}
          {settingsQuery.error || settingsQuery.data?.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              OMP settings metadata is unavailable. Showing the safe values read from the config
              file when available.
            </Text>
          ) : null}
          {settingsQuery.data?.droppedCount ? (
            <Text style={styles.muted}>
              {settingsQuery.data.droppedCount} settings use unsupported metadata types and are not
              shown.
            </Text>
          ) : null}
          {!settingsQuery.isLoading && catalog.sourceSettings.length === 0 ? (
            <Text style={styles.muted}>OMP reported no readable settings.</Text>
          ) : null}

          {catalog.sourceSettings.length > 0 ? (
            <View style={styles.workspace}>
              <View style={styles.categoryRail}>
                <TextInput
                  accessibilityLabel="Search OMP settings"
                  placeholder="Search settings"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={search}
                  onChangeText={setSearch}
                  style={styles.search}
                />
                <Text style={styles.source}>
                  {catalog.matching.length} of {catalog.sourceSettings.length} settings
                </Text>
                <View style={styles.categoryList}>
                  {visibleCategories.map((category) => {
                    const active = selectedCategory?.id === category.id;
                    const count = catalog.byCategory.get(category.id)?.length ?? 0;
                    return (
                      <Pressable
                        key={category.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => setActiveCategory(category.id)}
                        style={[styles.categoryButton, active ? styles.categoryButtonActive : null]}
                      >
                        <Text
                          style={[styles.categoryLabel, active ? styles.categoryLabelActive : null]}
                        >
                          {category.label} · {count}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={styles.categoryContent}>
                {selectedCategory ? (
                  <ConfigurationCategory
                    category={selectedCategory}
                    theme={theme}
                    modelCatalog={modelCatalog}
                    modelRoles={modelRoles}
                    styles={styles}
                    settings={catalog.byCategory.get(selectedCategory.id) ?? []}
                    drafts={drafts}
                    disabled={!settingsQuery.data?.revision || save.isPending}
                    workspaceScoped={cwd !== undefined}
                    onDraft={(path, draft) =>
                      setDrafts((current) => ({ ...current, [path]: draft }))
                    }
                    onOpenDocumentation={openDocumentation}
                  />
                ) : (
                  <Text style={styles.muted}>No settings match this search.</Text>
                )}
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function OmpStoreContent(
  props: PluginSurfaceProps & {
    cwd?: string;
    onComposerPillSettingsChange?: (settings: ComposerPillSettings) => void;
  },
) {
  const [store, setStore] = useState<OmpStore>();
  // Remount every editor when its target changes: drafts, confirmations, and mutation notices
  // belong to one store/workspace and must never be applied to the next selection.
  return (
    <OmpConfigContent
      key={`${ompStoreKey(store)}:${props.cwd ?? "global"}`}
      {...props}
      store={store}
      onStoreChange={setStore}
    />
  );
}

export function OmpConfigSurface(
  props: PluginSurfaceProps & {
    onComposerPillSettingsChange: (settings: ComposerPillSettings) => void;
  },
) {
  return <OmpStoreContent {...props} />;
}

export function OmpWorkspacePanel(props: PluginWorkspacePanelProps) {
  const cwd = useWorkspace(props.workspaceId, (workspace) => workspace.directory);
  if (!cwd) {
    return (
      <View
        style={{
          flex: 1,
          padding: props.layout.compact ? 16 : 24,
          backgroundColor: props.theme.colors.surface0,
        }}
      >
        <Text style={{ color: props.theme.colors.foregroundMuted }}>
          Loading workspace OMP settings…
        </Text>
      </View>
    );
  }
  return <OmpStoreContent {...props} cwd={cwd} />;
}
