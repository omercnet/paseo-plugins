import {
  type PluginWorkspacePanelProps,
  useRpc,
  useSettings,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  type GasCitySettings,
  gasCitySettings,
  resolveWorkspaceRig,
  toGasCityRpcSettings,
  type WorkspaceRigMapping,
} from "../shared";
import { CityOperations } from "./city-operations";
import { dismissSlingIntent, useSlingIntent } from "./dispatch-intent";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function FactoryPanel(props: PluginWorkspacePanelProps) {
  const settings = useSettings(gasCitySettings);
  if (settings.status === "loading") {
    return (
      <FactoryState
        {...props}
        title="Loading Factory"
        body="Reading persisted Gas City settings."
        loading
      />
    );
  }
  if (settings.status !== "ready") {
    return (
      <FactoryState
        {...props}
        title="Factory settings unavailable"
        body={settings.error}
        onRetry={() => void settings.reload()}
      />
    );
  }
  return (
    <ReadyFactoryPanel
      key={`${props.workspaceId}:${settings.revision}`}
      {...props}
      settings={settings.values}
    />
  );
}

function ReadyFactoryPanel({
  theme,
  layout,
  host,
  navigation,
  workspaceId,
  settings,
}: PluginWorkspacePanelProps & { settings: GasCitySettings }) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const rpcSettings = useMemo(() => toGasCityRpcSettings(settings), [settings]);
  const workspace = useWorkspace(workspaceId, ({ directory, name, title }) => ({
    directory,
    name,
    title,
  }));
  const loadMapping = useRpc(resolveWorkspaceRig);
  const mapping = useQuery({
    queryKey: ["gas-city", host.id, settings.endpointUrl, "workspace-mapping", workspaceId],
    queryFn: () => loadMapping({ settings: rpcSettings, workspaceId }),
    refetchInterval: settings.refreshIntervalMs,
  });
  const retryMapping = () => void mapping.refetch();
  const slingIntent = useSlingIntent(workspaceId);
  const dismissIntent = useCallback(
    (id: number) => dismissSlingIntent(workspaceId, id),
    [workspaceId],
  );

  if (mapping.isPending && !mapping.data) {
    return (
      <FactoryState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        context="workspace"
        workspaceId={workspaceId}
        title="Mapping workspace"
        body="Resolving this workspace to a Gas City rig."
        loading
      />
    );
  }
  if (mapping.error && !mapping.data) {
    return (
      <FactoryState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        context="workspace"
        workspaceId={workspaceId}
        title="Could not map workspace"
        body={errorMessage(mapping.error)}
        onRetry={retryMapping}
      />
    );
  }
  if (!mapping.data) {
    return (
      <FactoryState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        context="workspace"
        workspaceId={workspaceId}
        title="No workspace mapping"
        body="The supervisor returned no usable mapping result."
        onRetry={retryMapping}
      />
    );
  }

  const resolved = mapping.data;
  if (resolved.state !== "mapped" || !resolved.cityName || !resolved.rigName) {
    return (
      <MappingState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        context="workspace"
        workspaceId={workspaceId}
        mapping={resolved}
        onRetry={retryMapping}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.mappingBar}>
        <View style={styles.mappingIcon}>
          <Icon name="Factory" size={15} color={theme.colors.accent} />
        </View>
        <View style={styles.mappingText}>
          <Text style={styles.mappingTitle} numberOfLines={1}>
            {workspace?.title?.trim() || workspace?.name || "Workspace Factory"}
          </Text>
          <Text style={styles.mappingMeta} numberOfLines={1}>
            {resolved.cityName} / {resolved.rigName} ·{" "}
            {resolved.source === "explicit" ? "explicit mapping" : "path mapping"}
          </Text>
        </View>
        {mapping.isFetching ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
      </View>
      {resolved.diagnostics.length > 0 ? (
        <View accessibilityRole="alert" style={styles.diagnostics}>
          <Icon name="TriangleAlert" size={14} color={theme.colors.statusWarning} />
          <Text style={styles.diagnosticText} numberOfLines={2}>
            {resolved.diagnostics.map((diagnostic) => diagnostic.message).join(" · ")}
          </Text>
        </View>
      ) : null}
      <View style={styles.body}>
        <CityOperations
          key={`${settings.endpointUrl}:${resolved.cityName}:${resolved.rigName}`}
          theme={theme}
          layout={layout}
          host={host}
          cityName={resolved.cityName}
          rigName={resolved.rigName}
          settings={settings}
          slingIntent={slingIntent}
          onDismissSlingIntent={dismissIntent}
        />
      </View>
    </View>
  );
}

function MappingState({
  theme,
  layout,
  host,
  navigation,
  workspaceId,
  mapping,
  onRetry,
}: PluginWorkspacePanelProps & { mapping: WorkspaceRigMapping; onRetry: () => void }) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const title =
    mapping.state === "ambiguous"
      ? "Choose an explicit mapping"
      : mapping.state === "unavailable"
        ? "Supervisor mapping unavailable"
        : "Workspace is not mapped";
  const body =
    mapping.diagnostics.map((diagnostic) => diagnostic.message).join(" ") ||
    (mapping.state === "ambiguous"
      ? "Multiple Gas City rigs contain this workspace. Add an explicit override in Gas City settings."
      : "No Gas City rig contains this workspace path. Add an explicit override in Gas City settings.");
  return (
    <View style={styles.mappingStateScreen}>
      <FactoryState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        context="workspace"
        workspaceId={workspaceId}
        title={title}
        body={body}
        onRetry={onRetry}
      />
      {mapping.candidates.length > 0 ? (
        <ScrollView style={styles.candidates} contentContainerStyle={styles.candidatesContent}>
          <Text accessibilityRole="header" style={styles.candidatesTitle}>
            Mapping candidates
          </Text>
          {mapping.candidates.map((candidate) => (
            <View key={`${candidate.cityName}:${candidate.rigPath}`} style={styles.candidateRow}>
              <Icon name="GitBranch" size={14} color={theme.colors.foregroundMuted} />
              <View style={styles.mappingText}>
                <Text style={styles.mappingTitle}>
                  {candidate.cityName} / {candidate.rigName}
                </Text>
                <Text style={styles.mappingMeta} numberOfLines={1}>
                  {candidate.rigPath}
                </Text>
              </View>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function FactoryState({
  theme,
  title,
  body,
  loading,
  onRetry,
}: PluginWorkspacePanelProps & {
  title: string;
  body: string;
  loading?: boolean;
  onRetry?: () => void;
}) {
  const styles = useMemo(() => createStyles(theme, true), [theme]);
  return (
    <View style={styles.stateCard}>
      {loading ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <Icon name="Factory" size={28} color={theme.colors.foregroundMuted} />
      )}
      <Text accessibilityRole="header" style={styles.stateTitle}>
        {title}
      </Text>
      <Text style={styles.stateBody}>{body}</Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry Gas City workspace mapping"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    body: { flex: 1 },
    mappingBar: {
      minHeight: 54,
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      paddingHorizontal: compact ? 12 : 18,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    mappingIcon: {
      width: 30,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 7,
      backgroundColor: theme.colors.surface2,
    },
    mappingText: { flex: 1, minWidth: 0, gap: 2 },
    mappingTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "700" },
    mappingMeta: { color: theme.colors.foregroundMuted, fontSize: 10 },
    diagnostics: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingHorizontal: compact ? 12 : 18,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    diagnosticText: { flex: 1, color: theme.colors.statusWarning, fontSize: 10 },
    mappingStateScreen: { flex: 1, backgroundColor: theme.colors.surface0 },
    stateCard: {
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      padding: 24,
      backgroundColor: theme.colors.surface0,
    },
    stateTitle: {
      color: theme.colors.foreground,
      fontSize: 17,
      fontWeight: "800",
      textAlign: "center",
    },
    stateBody: {
      maxWidth: 480,
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
    },
    retryButton: {
      minHeight: 36,
      justifyContent: "center",
      paddingHorizontal: 13,
      borderRadius: 7,
      backgroundColor: theme.colors.accent,
    },
    retryText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" },
    candidates: {
      flex: 1,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    candidatesContent: { gap: 7, padding: compact ? 12 : 18 },
    candidatesTitle: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "800",
      marginBottom: 4,
    },
    candidateRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      padding: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    pressed: { opacity: 0.72 },
  });
}
