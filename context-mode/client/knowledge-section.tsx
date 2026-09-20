import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import {
  type ContextModeProvider,
  fetchAndIndexContextMode,
  indexContextModePath,
  type KnowledgeToolResult,
  purgeContextModeKnowledge,
  searchContextModeKnowledge,
} from "../shared/knowledge";

const PROVIDERS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "Copilot" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
  { value: "omp", label: "OMP" },
  { value: "omp-plugin", label: "OMP plugin" },
] as const;

const INSIGHT_URL = "https://context-mode.com/insight";
type Provider = ContextModeProvider;
type PurgeScope = "project" | "session";
export type KnowledgeSectionProps = Pick<PluginSurfaceProps, "theme" | "layout" | "host">;

interface KnowledgeStyles {
  section: ViewStyle;
  sectionHeader: ViewStyle;
  sectionTitle: TextStyle;
  card: ViewStyle;
  cardHeader: ViewStyle;
  cardTitle: TextStyle;
  muted: TextStyle;
  scopeNote: TextStyle;
  field: ViewStyle;
  fieldLabel: TextStyle;
  input: TextStyle;
  placeholder: TextStyle;
  choiceRow: ViewStyle;
  choice: ViewStyle;
  choiceSelected: ViewStyle;
  choiceText: TextStyle;
  choiceTextSelected: TextStyle;
  actions: ViewStyle;
  button: ViewStyle;
  primaryButton: ViewStyle;
  dangerButton: ViewStyle;
  disabled: ViewStyle;
  buttonText: TextStyle;
  primaryButtonText: TextStyle;
  dangerButtonText: TextStyle;
  linkButton: ViewStyle;
  linkText: TextStyle;
  pendingRow: ViewStyle;
  activity: { color: string };
  error: TextStyle;
  result: ViewStyle;
  metaRow: ViewStyle;
  metaLabel: TextStyle;
  metaValue: TextStyle;
  outputFrame: ViewStyle;
  output: TextStyle;
  confirmation: ViewStyle;
  confirmationTitle: TextStyle;
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  styles,
  accessibilityLabel,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText(value: string): void;
  placeholder: string;
  styles: KnowledgeStyles;
  accessibilityLabel: string;
  maxLength?: number;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        autoCapitalize="none"
        maxLength={maxLength}
        autoCorrect={false}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={styles.placeholder.color}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  danger = false,
  primary = false,
  styles,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
  styles: KnowledgeStyles;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.primaryButton : null,
        danger ? styles.dangerButton : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          primary ? styles.primaryButtonText : null,
          danger ? styles.dangerButtonText : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function WorkflowCard({
  title,
  description,
  children,
  styles,
}: {
  title: string;
  description: string;
  children: ReactNode;
  styles: KnowledgeStyles;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text accessibilityRole="header" style={styles.cardTitle}>
          {title}
        </Text>
        <Text style={styles.muted}>{description}</Text>
      </View>
      {children}
    </View>
  );
}

function ResultPanel({
  result,
  pending,
  error,
  emptyLabel,
  source,
  styles,
}: {
  result: KnowledgeToolResult | undefined;
  pending: boolean;
  error: unknown;
  emptyLabel: string;
  source?: string;
  styles: KnowledgeStyles;
}) {
  if (pending) {
    return (
      <View accessibilityLiveRegion="polite" style={styles.pendingRow}>
        <ActivityIndicator size="small" color={styles.activity.color} />
        <Text style={styles.muted}>Working…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <Text accessibilityRole="alert" style={styles.error}>
        {error instanceof Error ? error.message : String(error)}
      </Text>
    );
  }
  if (!result) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.result}>
      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Provider</Text>
        <Text selectable style={styles.metaValue}>
          {result.provider}
        </Text>
      </View>
      {source ? (
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Source</Text>
          <Text selectable style={styles.metaValue}>
            {source}
          </Text>
        </View>
      ) : null}
      <ScrollView nestedScrollEnabled style={styles.outputFrame}>
        <Text selectable style={styles.output}>
          {result.output || emptyLabel}
        </Text>
      </ScrollView>
    </View>
  );
}

export function KnowledgeSection({ theme, layout, host }: KnowledgeSectionProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const searchKnowledge = useRpc(searchContextModeKnowledge);
  const indexPath = useRpc(indexContextModePath);
  const fetchAndIndex = useRpc(fetchAndIndexContextMode);
  const purgeKnowledge = useRpc(purgeContextModeKnowledge);
  const queryClient = useQueryClient();
  const refreshAnalytics = () =>
    queryClient.invalidateQueries({
      queryKey: ["context-mode", host.id, "analytics-dashboard"],
    });

  const [provider, setProvider] = useState<Provider | null>("claude");
  const [projectPath, setProjectPath] = useState("");
  const [query, setQuery] = useState("");
  const [searchSource, setSearchSource] = useState("");
  const [path, setPath] = useState("");
  const [pathSource, setPathSource] = useState("");
  const [url, setUrl] = useState("");
  const [urlSource, setUrlSource] = useState("");
  const [purgeScope, setPurgeScope] = useState<PurgeScope | null>(null);
  const [searchResultSource, setSearchResultSource] = useState("");
  const [pathResultSource, setPathResultSource] = useState("");
  const [urlResultSource, setUrlResultSource] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [managementExpanded, setManagementExpanded] = useState(false);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const search = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select a provider store before searching.");
      const source = searchSource.trim();
      setSearchResultSource(source);
      return searchKnowledge({
        provider,
        projectPath: projectPath.trim(),
        queries: [query.trim()],
        ...(source ? { source } : {}),
      });
    },
  });
  const index = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select a provider store before indexing.");
      const source = pathSource.trim();
      setPathResultSource(source || path.trim());
      return indexPath({
        provider,
        projectPath: projectPath.trim(),
        path: path.trim(),
        ...(source ? { source } : {}),
      });
    },
    onSuccess: refreshAnalytics,
  });
  const fetch = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select a provider store before fetching.");
      const source = urlSource.trim();
      setUrlResultSource(source || url.trim());
      return fetchAndIndex({
        provider,
        projectPath: projectPath.trim(),
        url: url.trim(),
        ...(source ? { source } : {}),
      });
    },
    onSuccess: refreshAnalytics,
  });
  const purge = useMutation({
    mutationFn: () => {
      if (!provider || !purgeScope) throw new Error("Select a provider and purge scope.");
      if (purgeScope === "session") {
        return purgeKnowledge({
          provider,
          projectPath: projectPath.trim(),
          confirm: true,
          scope: "session",
          sessionId: sessionId.trim(),
        });
      }
      return purgeKnowledge({
        provider,
        projectPath: projectPath.trim(),
        confirm: true,
        scope: "project",
      });
    },
    onSuccess: refreshAnalytics,
    onSettled: () => setPurgeArmed(false),
  });

  const busy = search.isPending || index.isPending || fetch.isPending || purge.isPending;
  const changeProvider = (next: Provider) => {
    setProvider(next);
    setPurgeArmed(false);
    search.reset();
    index.reset();
    fetch.reset();
    purge.reset();
  };
  const changePurgeScope = (next: PurgeScope) => {
    setPurgeScope(next);
    setPurgeArmed(false);
    purge.reset();
  };
  const providerReady = provider !== null && projectPath.trim().length > 0;
  const canPreparePurge =
    providerReady &&
    purgeScope !== null &&
    (purgeScope !== "session" || sessionId.trim().length > 0);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Knowledge
        </Text>
        <Text style={styles.muted}>
          Search or add material in one provider-specific store. Nothing is copied between
          providers.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Provider store</Text>
        <View accessibilityRole="radiogroup" style={styles.choiceRow}>
          {PROVIDERS.map((option) => {
            const selected = provider === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityLabel={`${option.label} provider store`}
                disabled={busy}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: busy }}
                onPress={() => changeProvider(option.value)}
                style={[
                  styles.choice,
                  selected ? styles.choiceSelected : null,
                  busy ? styles.disabled : null,
                ]}
              >
                <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Field
          accessibilityLabel="Knowledge project path"
          label="Project path"
          maxLength={4_096}
          onChangeText={(value) => {
            setProjectPath(value);
            setPurgeArmed(false);
          }}
          placeholder="/absolute/path/to/project"
          styles={styles}
          value={projectPath}
        />
        <Text accessibilityLiveRegion="polite" style={styles.scopeNote}>
          {provider && projectPath.trim()
            ? `Current destination: ${PROVIDERS.find((item) => item.value === provider)?.label} storage for ${projectPath.trim()}.`
            : "Select a provider and absolute project path. No storage destination is selected by default."}
        </Text>
      </View>

      <WorkflowCard
        title="Search"
        description="Search indexed knowledge. Add a source filter when you only want matches from one named source."
        styles={styles}
      >
        <Field
          accessibilityLabel="Knowledge search query"
          label="Query"
          maxLength={1_024}
          onChangeText={setQuery}
          placeholder="What do you need to find?"
          styles={styles}
          value={query}
        />
        <Field
          accessibilityLabel="Knowledge search source filter"
          label="Source filter (optional)"
          maxLength={512}
          onChangeText={setSearchSource}
          placeholder="docs, repository, or source label"
          styles={styles}
          value={searchSource}
        />
        <View style={styles.actions}>
          <ActionButton
            disabled={!providerReady || query.trim().length === 0 || search.isPending}
            label={search.isPending ? "Searching…" : "Search knowledge"}
            onPress={() => search.mutate()}
            primary
            styles={styles}
          />
        </View>
        <ResultPanel
          emptyLabel="No matching knowledge was returned."
          error={search.error}
          pending={search.isPending}
          result={search.data}
          source={searchResultSource || undefined}
          styles={styles}
        />
      </WorkflowCard>

      <Pressable
        accessibilityLabel={managementExpanded ? "Hide source management" : "Add or manage sources"}
        accessibilityRole="button"
        accessibilityState={{ expanded: managementExpanded }}
        onPress={() => setManagementExpanded((expanded) => !expanded)}
        style={styles.button}
      >
        <Text style={styles.buttonText}>
          {managementExpanded ? "Hide source management" : "Add or manage sources"}
        </Text>
      </Pressable>

      {managementExpanded ? (
        <>
          <WorkflowCard
            title="Source visibility"
            description="Open Context Mode Insight to inspect indexed sources and understand what is available to search."
            styles={styles}
          >
            <View style={styles.actions}>
              <ExternalLink
                accessibilityLabel="Open Context Mode Insight in a browser"
                href={INSIGHT_URL}
                onError={(error) =>
                  setLinkError(error instanceof Error ? error.message : String(error))
                }
              >
                <View style={styles.linkButton}>
                  <Text style={styles.linkText}>Open Insight</Text>
                </View>
              </ExternalLink>
            </View>
            {linkError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                Could not open Insight: {linkError}
              </Text>
            ) : null}
          </WorkflowCard>

          <WorkflowCard
            title="Index a local path"
            description="Add a file or directory from the selected provider environment. The source label stays visible with the indexed material."
            styles={styles}
          >
            <Field
              accessibilityLabel="Local path to index"
              label="Local path"
              maxLength={4_096}
              onChangeText={setPath}
              placeholder="/absolute/path/to/docs"
              styles={styles}
              value={path}
            />
            <Field
              accessibilityLabel="Local path source label"
              label="Source label (optional)"
              maxLength={512}
              onChangeText={setPathSource}
              placeholder="project-docs"
              styles={styles}
              value={pathSource}
            />
            <View style={styles.actions}>
              <ActionButton
                disabled={!providerReady || path.trim().length === 0 || index.isPending}
                label={index.isPending ? "Indexing…" : "Index path"}
                onPress={() => index.mutate()}
                styles={styles}
              />
            </View>
            <ResultPanel
              emptyLabel="Context Mode completed without a text report."
              error={index.error}
              pending={index.isPending}
              result={index.data}
              source={pathResultSource || undefined}
              styles={styles}
            />
          </WorkflowCard>

          <WorkflowCard
            title="Fetch and index a URL"
            description="Fetch one HTTP or HTTPS source and add it to the selected provider store."
            styles={styles}
          >
            <Field
              accessibilityLabel="URL to fetch and index"
              label="URL"
              maxLength={4_096}
              onChangeText={setUrl}
              placeholder="https://docs.example.com/guide"
              styles={styles}
              value={url}
            />
            <Field
              accessibilityLabel="Fetched URL source label"
              label="Source label (optional)"
              maxLength={512}
              onChangeText={setUrlSource}
              placeholder="product-guide"
              styles={styles}
              value={urlSource}
            />
            <View style={styles.actions}>
              <ActionButton
                disabled={!providerReady || url.trim().length === 0 || fetch.isPending}
                label={fetch.isPending ? "Fetching…" : "Fetch and index"}
                onPress={() => fetch.mutate()}
                styles={styles}
              />
            </View>
            <ResultPanel
              emptyLabel="Context Mode completed without a text report."
              error={fetch.error}
              pending={fetch.isPending}
              result={fetch.data}
              source={urlResultSource || undefined}
              styles={styles}
            />
          </WorkflowCard>

          <WorkflowCard
            title="Purge knowledge"
            description="Purge only the selected provider store and scope. Select a scope, review it, then confirm."
            styles={styles}
          >
            <Text style={styles.fieldLabel}>Scope</Text>
            <View accessibilityRole="radiogroup" style={styles.choiceRow}>
              {(["project", "session"] as const).map((scope) => {
                const selected = purgeScope === scope;
                const label = scope === "project" ? "Project" : "Session";
                return (
                  <Pressable
                    key={scope}
                    accessibilityLabel={`Purge ${label.toLowerCase()} scope`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    onPress={() => changePurgeScope(scope)}
                    style={[styles.choice, selected ? styles.choiceSelected : null]}
                  >
                    <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {purgeScope === "session" ? (
              <Field
                accessibilityLabel="Session identifier to purge"
                label="Session ID"
                maxLength={256}
                onChangeText={(value) => {
                  setSessionId(value);
                  setPurgeArmed(false);
                }}
                placeholder="Exact Context Mode session ID"
                styles={styles}
                value={sessionId}
              />
            ) : null}
            {!purgeArmed ? (
              <View style={styles.actions}>
                <ActionButton
                  danger
                  disabled={!canPreparePurge || purge.isPending}
                  label="Review purge"
                  onPress={() => setPurgeArmed(true)}
                  styles={styles}
                />
              </View>
            ) : (
              <View accessibilityRole="alert" style={styles.confirmation}>
                <Text style={styles.confirmationTitle}>Confirm permanent purge</Text>
                <Text style={styles.muted}>
                  {`Delete ${purgeScope === "session" ? `session ${sessionId.trim()}` : "project"} knowledge from ${provider} storage? This does not affect other providers.`}
                </Text>
                <View style={styles.actions}>
                  <ActionButton
                    danger
                    label={purge.isPending ? "Purging…" : "Confirm purge"}
                    onPress={() => purge.mutate()}
                    styles={styles}
                  />
                  <ActionButton
                    disabled={purge.isPending}
                    label="Cancel"
                    onPress={() => setPurgeArmed(false)}
                    styles={styles}
                  />
                </View>
              </View>
            )}
            <ResultPanel
              emptyLabel="The selected knowledge scope was purged."
              error={purge.error}
              pending={purge.isPending}
              result={purge.data}
              styles={styles}
            />
          </WorkflowCard>
        </>
      ) : null}
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean): KnowledgeStyles {
  return {
    section: { width: "100%" as const, gap: compact ? 12 : 16 },
    sectionHeader: { gap: 4 },
    sectionTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 18 : 20,
      fontWeight: "700" as const,
    },
    card: {
      width: "100%" as const,
      gap: 12,
      padding: compact ? 12 : 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    cardHeader: { gap: 3 },
    cardTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "700" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    scopeNote: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    field: { gap: 5 },
    fieldLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    input: {
      minHeight: 40,
      width: "100%" as const,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      paddingHorizontal: 11,
      paddingVertical: 8,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface0,
      fontSize: 14,
    },
    placeholder: { color: theme.colors.foregroundMuted },
    choiceRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 7 },
    choice: {
      minHeight: 36,
      justifyContent: "center" as const,
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 999,
      backgroundColor: theme.colors.surface0,
    },
    choiceSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    choiceText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
    choiceTextSelected: { color: theme.colors.accentForeground },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    button: {
      minHeight: 38,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: 13,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    primaryButton: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    dangerButton: {
      borderColor: theme.colors.statusDanger,
      backgroundColor: theme.colors.surface1,
    },
    disabled: { opacity: 0.5 },
    buttonText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    primaryButtonText: { color: theme.colors.accentForeground },
    dangerButtonText: { color: theme.colors.statusDanger },
    linkButton: {
      minHeight: 38,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: 13,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    linkText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    pendingRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    activity: { color: theme.colors.accent },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
    result: {
      gap: 7,
      padding: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    metaRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
    metaLabel: { width: 58, color: theme.colors.foregroundMuted, fontSize: 11 },
    metaValue: { flex: 1, color: theme.colors.foreground, fontSize: 11 },
    outputFrame: { maxHeight: compact ? 160 : 220 },
    output: {
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: compact ? 11 : 12,
      lineHeight: compact ? 16 : 18,
    },
    confirmation: {
      gap: 9,
      padding: 11,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    confirmationTitle: {
      color: theme.colors.statusDanger,
      fontSize: 13,
      fontWeight: "700" as const,
    },
  };
}
