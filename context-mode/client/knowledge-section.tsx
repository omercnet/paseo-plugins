import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
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
  fetchAndIndexContextMode,
  indexContextModePath,
  type KnowledgeToolResult,
  type PurgeKnowledgeInput,
  purgeContextModeKnowledge,
  type SearchKnowledgeResult,
  type SearchPage,
  searchContextModeKnowledge,
} from "../shared/knowledge";
import type { KnowledgeScope } from "./screen-scope";

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  opencode: "OpenCode",
};

/** Used until the integration audit reports the configured providers. */
export const BUILTIN_KNOWLEDGE_PROVIDERS = Object.keys(PROVIDER_LABELS);

const providerLabel = (id: string) => PROVIDER_LABELS[id] ?? id;

type Provider = string;
type PurgeScope = "project" | "session" | "source";
type SearchScope = "worktree" | "project";
const SEARCH_SCOPES: ReadonlyArray<{ value: SearchScope; label: string }> = [
  { value: "worktree", label: "Worktree" },
  { value: "project", label: "Project" },
];

interface SearchRequest {
  provider: Provider;
  projectPath: string;
  queries: string[];
  scope: SearchScope;
  source?: string;
}
const PURGE_SCOPES: ReadonlyArray<{ value: PurgeScope; label: string }> = [
  { value: "project", label: "Project" },
  { value: "session", label: "Session" },
  { value: "source", label: "Source" },
];

/** What `ctx_purge` removes per scope: a session purge deletes only its journal, never indexed sources. */
const PURGE_CONSEQUENCE: Readonly<Record<PurgeScope, string>> = {
  project: "Every agent working in this project loses its recorded activity and indexed sources.",
  session: "The session's recorded activity and resume state are deleted; indexed sources stay.",
  source: "Every agent working in this project loses it.",
};
export type KnowledgeSectionProps = Pick<PluginSurfaceProps, "theme" | "layout" | "host"> & {
  initialScope?: KnowledgeScope;
  /** Paseo provider ids Context Mode supports: the built-ins plus configured providers extending one. */
  providers: readonly string[];
};

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
  accessibilityLabel,
  onPress,
  disabled = false,
  danger = false,
  primary = false,
  styles,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress(): void;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
  styles: KnowledgeStyles;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
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

function Choices<T extends string>({
  options,
  value,
  onChange,
  label,
  styles,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange(value: T): void;
  label: (option: string) => string;
  styles: KnowledgeStyles;
}) {
  return (
    <View accessibilityRole="radiogroup" style={styles.choiceRow}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityLabel={label(option.label)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            style={[styles.choice, selected ? styles.choiceSelected : null]}
          >
            <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Drops agent-only footers (the More results button pages instead) and tool-name prefixes. */
export function presentKnowledgeOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^[Mm]ore: ctx_search\(/.test(line))
    .map((line) => line.replace(/^ctx_[a-z_]+: /, ""))
    .join("\n")
    .trim();
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
        <Text style={styles.metaLabel}>Agent</Text>
        <Text selectable style={styles.metaValue}>
          {providerLabel(result.provider)}
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
          {presentKnowledgeOutput(result.output) || emptyLabel}
        </Text>
      </ScrollView>
    </View>
  );
}

export function KnowledgeSection({
  theme,
  layout,
  host,
  initialScope,
  providers,
}: KnowledgeSectionProps) {
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

  const scopedProvider = initialScope?.provider ?? null;
  const scopedProviderKnown = scopedProvider !== null && providers.includes(scopedProvider);
  const note =
    initialScope?.note ??
    (scopedProvider && !scopedProviderKnown
      ? `Provider ${scopedProvider} is not supported by Context Mode 2. Select a supported agent.`
      : undefined);
  const [provider, setProvider] = useState<Provider | null>(
    initialScope ? (scopedProviderKnown ? scopedProvider : null) : "claude",
  );
  const [projectPath, setProjectPath] = useState(initialScope?.projectPath ?? "");
  const [query, setQuery] = useState("");
  const [searchSource, setSearchSource] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("worktree");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [purgeScope, setPurgeScope] = useState<PurgeScope | null>(null);
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const [searchPages, setSearchPages] = useState<SearchKnowledgeResult[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [purgeSource, setPurgeSource] = useState("");
  const [managementExpanded, setManagementExpanded] = useState(false);
  const [purgeArmed, setPurgeArmed] = useState(false);

  const search = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select an agent before searching.");
      const source = searchSource.trim();
      const request: SearchRequest = {
        provider,
        projectPath: projectPath.trim(),
        queries: [query.trim()],
        scope: searchScope,
        ...(source ? { source } : {}),
      };
      setSearchRequest(request);
      setSearchPages([]);
      return searchKnowledge(request);
    },
    onSuccess: (result) => setSearchPages([result]),
  });
  const moreResults = useMutation({
    mutationFn: (page: SearchPage) => {
      if (!searchRequest) throw new Error("Run a search before loading more results.");
      return searchKnowledge({ ...searchRequest, page });
    },
    onSuccess: (result) => setSearchPages((pages) => [...pages, result]),
  });
  const index = useMutation({
    mutationFn: (target: string) => {
      if (!provider) throw new Error("Select an agent before indexing.");
      return indexPath({ provider, projectPath: projectPath.trim(), path: target });
    },
    onSuccess: refreshAnalytics,
  });
  const fetch = useMutation({
    mutationFn: (target: string) => {
      if (!provider) throw new Error("Select an agent before indexing a URL.");
      return fetchAndIndex({ provider, projectPath: projectPath.trim(), url: target });
    },
    onSuccess: refreshAnalytics,
  });
  const purge = useMutation({
    mutationFn: () => {
      if (!provider || !purgeScope) throw new Error("Select an agent and purge scope.");
      if (purgeScope === "session") {
        return purgeKnowledge({
          provider,
          projectPath: projectPath.trim(),
          confirm: true,
          scope: "session",
          sessionId: sessionId.trim(),
        });
      }
      if (purgeScope === "source") {
        return purgeKnowledge({
          provider,
          projectPath: projectPath.trim(),
          confirm: true,
          scope: "source",
          source: purgeSource.trim(),
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

  const busy =
    search.isPending ||
    moreResults.isPending ||
    index.isPending ||
    fetch.isPending ||
    purge.isPending;
  const changeProvider = (next: Provider) => {
    setProvider(next);
    setPurgeArmed(false);
    setSearchRequest(null);
    setSearchPages([]);
    search.reset();
    moreResults.reset();
    index.reset();
    fetch.reset();
    purge.reset();
  };
  const startSearch = () => {
    moreResults.reset();
    search.mutate();
  };
  const nextSearchPage = searchPages[searchPages.length - 1]?.next ?? null;
  const changePurgeScope = (next: PurgeScope) => {
    setPurgeScope(next);
    setPurgeArmed(false);
    purge.reset();
  };
  const providerReady = provider !== null && projectPath.trim().length > 0;
  const canPreparePurge =
    providerReady &&
    purgeScope !== null &&
    (purgeScope !== "session" || sessionId.trim().length > 0) &&
    (purgeScope !== "source" || purgeSource.trim().length > 0);
  const purgeTarget =
    purgeScope === "session"
      ? `session ${sessionId.trim()}`
      : purgeScope === "source"
        ? `source ${purgeSource.trim()}`
        : "all project";
  const purgeConsequence = purgeScope ? PURGE_CONSEQUENCE[purgeScope] : "";

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Knowledge
        </Text>
        <Text style={styles.muted}>
          Search or add material in the Context Mode store of one project. Every agent working in
          that project shares it; the agent only labels who added what.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Agent</Text>
        {note ? <Text style={styles.scopeNote}>{note}</Text> : null}
        <View accessibilityRole="radiogroup" style={styles.choiceRow}>
          {providers.map((id) => {
            const selected = provider === id;
            return (
              <Pressable
                key={id}
                accessibilityLabel={`${providerLabel(id)} agent`}
                disabled={busy}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: busy }}
                onPress={() => changeProvider(id)}
                style={[
                  styles.choice,
                  selected ? styles.choiceSelected : null,
                  busy ? styles.disabled : null,
                ]}
              >
                <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>
                  {providerLabel(id)}
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
            ? `Current destination: the project store for ${projectPath.trim()}, recorded as ${providerLabel(provider)}.`
            : "Select an agent and absolute project path. No destination is selected by default."}
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
        <Text style={styles.fieldLabel}>Scope</Text>
        <Choices<SearchScope>
          label={(option) => `Search ${option.toLowerCase()} scope`}
          onChange={setSearchScope}
          options={SEARCH_SCOPES}
          styles={styles}
          value={searchScope}
        />
        <View style={styles.actions}>
          <ActionButton
            disabled={
              !providerReady ||
              query.trim().length === 0 ||
              search.isPending ||
              moreResults.isPending
            }
            label={search.isPending ? "Searching…" : "Search knowledge"}
            onPress={startSearch}
            primary
            styles={styles}
          />
        </View>
        <ResultPanel
          emptyLabel="No matching knowledge was returned."
          error={search.error}
          pending={search.isPending}
          result={search.data}
          source={searchRequest?.source}
          styles={styles}
        />
        {searchPages.slice(1).map((page, pageIndex) => (
          <View
            key={`${page.completedAt}:${pageIndex}`}
            accessibilityLiveRegion="polite"
            style={styles.result}
          >
            <Text style={styles.metaLabel}>Page {pageIndex + 2}</Text>
            <ScrollView nestedScrollEnabled style={styles.outputFrame}>
              <Text selectable style={styles.output}>
                {presentKnowledgeOutput(page.output) || "No more matching knowledge was returned."}
              </Text>
            </ScrollView>
          </View>
        ))}
        {nextSearchPage && !search.isPending ? (
          <View style={styles.actions}>
            <ActionButton
              accessibilityLabel="Load more search results"
              disabled={moreResults.isPending}
              label={moreResults.isPending ? "Loading…" : "More results"}
              onPress={() => moreResults.mutate(nextSearchPage)}
              styles={styles}
            />
          </View>
        ) : null}
        {moreResults.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {moreResults.error instanceof Error
              ? moreResults.error.message
              : String(moreResults.error)}
          </Text>
        ) : null}
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
            title="Index a local path"
            description="Add a file or directory inside the selected project."
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
            <View style={styles.actions}>
              <ActionButton
                disabled={!providerReady || path.trim().length === 0 || index.isPending}
                label={index.isPending ? "Indexing…" : "Index path"}
                onPress={() => index.mutate(path.trim())}
                styles={styles}
              />
            </View>
            <ResultPanel
              emptyLabel="Context Mode completed without a text report."
              error={index.error}
              pending={index.isPending}
              result={index.data}
              source={index.variables}
              styles={styles}
            />
          </WorkflowCard>

          <WorkflowCard
            title="Index a URL"
            description="Fetch one public HTTP or HTTPS page and add it to the selected project store."
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
            <View style={styles.actions}>
              <ActionButton
                disabled={!providerReady || url.trim().length === 0 || fetch.isPending}
                label={fetch.isPending ? "Indexing…" : "Index URL"}
                onPress={() => fetch.mutate(url.trim())}
                styles={styles}
              />
            </View>
            <ResultPanel
              emptyLabel="Context Mode completed without a text report."
              error={fetch.error}
              pending={fetch.isPending}
              result={fetch.data}
              source={fetch.variables}
              styles={styles}
            />
          </WorkflowCard>

          <WorkflowCard
            title="Purge knowledge"
            description="Purge part of the selected project store for every agent. Select a scope, review it, then confirm."
            styles={styles}
          >
            <Text style={styles.fieldLabel}>Scope</Text>
            <Choices
              label={(option) => `Purge ${option.toLowerCase()} scope`}
              onChange={changePurgeScope}
              options={PURGE_SCOPES}
              styles={styles}
              value={purgeScope}
            />
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
            {purgeScope === "source" ? (
              <Field
                accessibilityLabel="Source label to forget"
                label="Source label"
                maxLength={512}
                onChangeText={(value) => {
                  setPurgeSource(value);
                  setPurgeArmed(false);
                }}
                placeholder="Exact indexed source label"
                styles={styles}
                value={purgeSource}
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
                  {`Delete ${purgeTarget} from the ${projectPath.trim()} store? ${purgeConsequence}`}
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

type ForgetButtonProps = Pick<PluginSurfaceProps, "theme" | "host"> & {
  provider: string;
  projectPath: string;
};

type ForgetTarget = { scope: "source"; source: string } | { scope: "session"; sessionId: string };

/** Per-row "Forget" with the same review-then-confirm step as purge. */
function ForgetButton({
  theme,
  host,
  provider,
  projectPath,
  target,
  targetLabel,
}: ForgetButtonProps & { target: ForgetTarget; targetLabel: string }) {
  const styles = useMemo(() => createStyles(theme, true), [theme]);
  const purgeKnowledge = useRpc(purgeContextModeKnowledge);
  const queryClient = useQueryClient();
  const [armed, setArmed] = useState(false);
  const forget = useMutation({
    mutationFn: () => {
      const input: PurgeKnowledgeInput = { provider, projectPath, confirm: true, ...target };
      return purgeKnowledge(input);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["context-mode", host.id, "analytics-dashboard"],
      }),
    onSettled: () => setArmed(false),
  });
  if (forget.isSuccess) return <Text style={styles.muted}>Forgotten.</Text>;
  return (
    <View style={styles.field}>
      {armed ? (
        <View accessibilityRole="alert" style={styles.confirmation}>
          <Text style={styles.muted}>
            {`Forget ${targetLabel} from the ${projectPath} store? ${PURGE_CONSEQUENCE[target.scope]}`}
          </Text>
          <View style={styles.actions}>
            <ActionButton
              accessibilityLabel={`Confirm forget ${targetLabel}`}
              danger
              label={forget.isPending ? "Forgetting…" : "Confirm forget"}
              onPress={() => forget.mutate()}
              styles={styles}
            />
            <ActionButton
              disabled={forget.isPending}
              label="Cancel"
              onPress={() => setArmed(false)}
              styles={styles}
            />
          </View>
        </View>
      ) : (
        <ActionButton
          accessibilityLabel={`Forget ${targetLabel}`}
          danger
          label="Forget"
          onPress={() => setArmed(true)}
          styles={styles}
        />
      )}
      {forget.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {forget.error instanceof Error ? forget.error.message : String(forget.error)}
        </Text>
      ) : null}
    </View>
  );
}

export type ForgetSourceButtonProps = ForgetButtonProps & { source: string };

/** Forgets one indexed source from the project store. */
export function ForgetSourceButton({ source, ...props }: ForgetSourceButtonProps) {
  return <ForgetButton {...props} target={{ scope: "source", source }} targetLabel={source} />;
}

export type ForgetSessionButtonProps = ForgetButtonProps & { sessionId: string };

/** Forgets one recorded session's events from the project store. */
export function ForgetSessionButton({ sessionId, ...props }: ForgetSessionButtonProps) {
  return (
    <ForgetButton
      {...props}
      target={{ scope: "session", sessionId }}
      targetLabel={`session ${sessionId}`}
    />
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
