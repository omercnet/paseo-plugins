import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { ScrollView, SettingsSection, TextInput } from "@getpaseo/plugin/client/ui";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import {
  type FetchAndIndexInput,
  fetchAndIndexContextMode,
  type IndexPathInput,
  indexContextModePath,
  type KnowledgeToolResult,
  type PurgeKnowledgeInput,
  purgeContextModeKnowledge,
  type SearchKnowledgeInput,
  type SearchKnowledgeResult,
  type SearchPage,
  searchContextModeKnowledge,
} from "../shared/knowledge";
import { CONTEXT_MODE_PROVIDERS, IN_PROCESS_PROVIDERS } from "../shared/providers";
import { ActionButton, Card, type ChoiceOption, Choices, ErrorText, Pending } from "./controls";
import type { KnowledgeScope } from "./screen-scope";

/** Used until the integration audit reports the configured providers. */
export const BUILTIN_KNOWLEDGE_PROVIDERS: readonly string[] = CONTEXT_MODE_PROVIDERS.map(
  ({ provider }) => provider,
);

/** Built-in providers by name; configured providers (for example `claude-work`) by their id. */
export function providerLabel(id: string): string {
  const entry = [...CONTEXT_MODE_PROVIDERS, ...IN_PROCESS_PROVIDERS].find(
    ({ provider }) => provider === id,
  );
  return entry ? entry.label : id;
}

type SearchScope = SearchKnowledgeInput["scope"];
type SearchSort = SearchKnowledgeInput["sort"];
type PurgeScope = PurgeKnowledgeInput["scope"];

const SEARCH_SCOPES: readonly ChoiceOption<SearchScope>[] = [
  { value: "worktree", label: "Worktree" },
  { value: "project", label: "Project" },
];

/** Timeline is upstream's oldest-first order. */
const SEARCH_SORTS: readonly ChoiceOption<SearchSort>[] = [
  { value: "relevance", label: "Relevance" },
  { value: "timeline", label: "Timeline" },
];

const PURGE_SCOPES: readonly ChoiceOption<PurgeScope>[] = [
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

/** The project store a knowledge action writes to, and the agent it is recorded as. */
interface Destination {
  provider: string;
  projectPath: string;
}

type PurgeTarget =
  | { scope: "project" }
  | { scope: "session"; sessionId: string }
  | { scope: "source"; source: string };
type ForgetTarget = Exclude<PurgeTarget, { scope: "project" }>;

interface MoreResultsInput {
  request: SearchKnowledgeInput;
  page: SearchPage;
}

function knowledgeMutationKey(hostId: string) {
  return ["context-mode", hostId, "knowledge"] as const;
}

function useRefreshAnalytics(hostId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: ["context-mode", hostId, "analytics-dashboard"] });
}

function describePurgeTarget(target: PurgeTarget): string {
  if (target.scope === "session") return `session ${target.sessionId}`;
  if (target.scope === "source") return `source ${target.source}`;
  return "all project knowledge";
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

function createStyles(theme: PluginTheme) {
  return {
    muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
    fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" as const },
    cardTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" as const },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    result: {
      gap: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    metaRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
    metaLabel: { width: 56, color: theme.colors.foregroundMuted, fontSize: 12 },
    metaValue: { flex: 1, color: theme.colors.foreground, fontSize: 12 },
    output: {
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: 12,
      lineHeight: 16,
    },
  };
}

interface FieldProps {
  theme: PluginTheme;
  label: string;
  value: string;
  onChangeText(value: string): void;
  placeholder: string;
  accessibilityLabel: string;
  maxLength: number;
}

function Field({
  theme,
  label,
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  maxLength,
}: FieldProps) {
  const styles = createStyles(theme);
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={maxLength}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          minHeight: 32,
          width: "100%",
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface0,
          fontSize: 14,
        }}
        value={value}
      />
    </View>
  );
}

interface WorkflowCardProps {
  theme: PluginTheme;
  title: string;
  description: string;
  children: ReactNode;
}

function WorkflowCard({ theme, title, description, children }: WorkflowCardProps) {
  const styles = createStyles(theme);
  return (
    <Card theme={theme}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={styles.cardTitle}>
          {title}
        </Text>
        <Text style={styles.muted}>{description}</Text>
      </View>
      {children}
    </Card>
  );
}

interface LabeledChoicesProps<Value extends string> {
  theme: PluginTheme;
  label: string;
  options: readonly ChoiceOption<Value>[];
  value: Value | null;
  onChange(value: Value): void;
  accessibilityLabel(option: ChoiceOption<Value>): string;
  disabled?: boolean;
}

function LabeledChoices<Value extends string>({ label, ...choices }: LabeledChoicesProps<Value>) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={createStyles(choices.theme).fieldLabel}>{label}</Text>
      <Choices {...choices} />
    </View>
  );
}

interface OutputFrameProps {
  theme: PluginTheme;
  output: string;
  emptyLabel: string;
}

function OutputFrame({ theme, output, emptyLabel }: OutputFrameProps) {
  return (
    <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }}>
      <Text selectable style={createStyles(theme).output}>
        {presentKnowledgeOutput(output) || emptyLabel}
      </Text>
    </ScrollView>
  );
}

interface ResultPanelProps {
  theme: PluginTheme;
  result: KnowledgeToolResult | undefined;
  pending: boolean;
  error: unknown;
  emptyLabel: string;
  source?: string;
}

function ResultPanel({ theme, result, pending, error, emptyLabel, source }: ResultPanelProps) {
  const styles = createStyles(theme);
  if (pending) return <Pending theme={theme} label="Working..." />;
  if (error) return <ErrorText theme={theme} error={error} />;
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
      <OutputFrame theme={theme} output={result.output} emptyLabel={emptyLabel} />
    </View>
  );
}

interface ConfirmPanelProps {
  theme: PluginTheme;
  message: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  confirmAccessibilityLabel?: string;
  onConfirm(): void;
  onCancel(): void;
}

/** The review step before a permanent delete: the only place a destructive button appears. */
function ConfirmPanel({
  theme,
  message,
  confirmLabel,
  pendingLabel,
  pending,
  confirmAccessibilityLabel,
  onConfirm,
  onCancel,
}: ConfirmPanelProps) {
  const styles = createStyles(theme);
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <Text style={styles.muted}>{message}</Text>
      <View style={styles.actions}>
        <ActionButton
          theme={theme}
          variant="destructive"
          accessibilityLabel={confirmAccessibilityLabel}
          disabled={pending}
          label={pending ? pendingLabel : confirmLabel}
          onPress={onConfirm}
        />
        <ActionButton theme={theme} disabled={pending} label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

export interface KnowledgeSectionProps extends Pick<PluginSurfaceProps, "theme" | "host"> {
  initialScope?: KnowledgeScope;
  /** Paseo provider ids Context Mode supports: the built-ins plus configured providers extending one. */
  providers: readonly string[];
}

function initialProvider(scope: KnowledgeScope | undefined, providers: readonly string[]) {
  if (!scope) return "claude";
  if (scope.provider !== null && providers.includes(scope.provider)) return scope.provider;
  return null;
}

function scopeNote(scope: KnowledgeScope | undefined, providers: readonly string[]) {
  if (scope?.note) return scope.note;
  if (!scope?.provider || providers.includes(scope.provider)) return null;
  return `Provider ${scope.provider} is not supported by Context Mode 2. Select a supported agent.`;
}

export function KnowledgeSection({ theme, host, initialScope, providers }: KnowledgeSectionProps) {
  const styles = createStyles(theme);
  const note = scopeNote(initialScope, providers);
  const [provider, setProvider] = useState<string | null>(() =>
    initialProvider(initialScope, providers),
  );
  const [projectPath, setProjectPath] = useState(initialScope?.projectPath ?? "");
  const [managementExpanded, setManagementExpanded] = useState(false);
  const busy = useIsMutating({ mutationKey: knowledgeMutationKey(host.id) }) > 0;
  const trimmedPath = projectPath.trim();
  const destination: Destination | null =
    provider !== null && trimmedPath ? { provider, projectPath: trimmedPath } : null;
  const destinationNote = destination
    ? `Current destination: the project store for ${destination.projectPath}, recorded as ${providerLabel(destination.provider)}.`
    : "Select an agent and absolute project path. No destination is selected by default.";
  const providerOptions = providers.map((id) => ({ value: id, label: providerLabel(id) }));
  // Results belong to the agent they were recorded as, so a new agent starts the workflows fresh.
  const workflowKey = provider ?? "none";

  return (
    <SettingsSection
      title="Knowledge"
      info="Search or add material in the Context Mode store of one project. Every agent working in that project shares it; the agent only labels who added what."
    >
      <View style={{ gap: 16 }}>
        <Card theme={theme}>
          {note ? <Text style={styles.muted}>{note}</Text> : null}
          <LabeledChoices
            theme={theme}
            label="Agent"
            disabled={busy}
            accessibilityLabel={(option) => `${option.label} agent`}
            onChange={setProvider}
            options={providerOptions}
            value={provider}
          />
          <Field
            theme={theme}
            accessibilityLabel="Knowledge project path"
            label="Project path"
            maxLength={4_096}
            onChangeText={setProjectPath}
            placeholder="/absolute/path/to/project"
            value={projectPath}
          />
          <Text accessibilityLiveRegion="polite" style={styles.muted}>
            {destinationNote}
          </Text>
        </Card>

        <SearchCard
          key={`search:${workflowKey}`}
          theme={theme}
          hostId={host.id}
          destination={destination}
        />

        <ActionButton
          theme={theme}
          variant="outline"
          disabled={busy}
          expanded={managementExpanded}
          label={managementExpanded ? "Hide source management" : "Add or manage sources"}
          onPress={() => setManagementExpanded((expanded) => !expanded)}
        />

        {managementExpanded ? (
          <SourceManagement
            key={`sources:${workflowKey}`}
            theme={theme}
            hostId={host.id}
            destination={destination}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

interface WorkflowProps {
  theme: PluginTheme;
  hostId: string;
  destination: Destination | null;
}

function SearchCard({ theme, hostId, destination }: WorkflowProps) {
  const styles = createStyles(theme);
  const searchKnowledge = useRpc(searchContextModeKnowledge);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<SearchScope>("worktree");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [extraPages, setExtraPages] = useState<SearchKnowledgeResult[]>([]);
  const search = useMutation({
    mutationKey: knowledgeMutationKey(hostId),
    mutationFn: (request: SearchKnowledgeInput) => searchKnowledge(request),
    onMutate: () => setExtraPages([]),
  });
  const moreResults = useMutation({
    mutationKey: knowledgeMutationKey(hostId),
    mutationFn: ({ request, page }: MoreResultsInput) => searchKnowledge({ ...request, page }),
    onSuccess: (result) => setExtraPages((pages) => [...pages, result]),
  });
  const request = search.variables;
  const lastPage = extraPages.at(-1) ?? search.data;
  const nextPage = lastPage?.next ?? null;
  const trimmedQuery = query.trim();
  const canSearch = destination !== null && trimmedQuery.length > 0;

  function startSearch() {
    if (!destination) return;
    const trimmedSource = source.trim();
    moreResults.reset();
    search.mutate({
      ...destination,
      queries: [trimmedQuery],
      scope,
      sort,
      ...(trimmedSource ? { source: trimmedSource } : {}),
    });
  }

  function loadMore() {
    if (request && nextPage) moreResults.mutate({ request, page: nextPage });
  }

  return (
    <WorkflowCard
      theme={theme}
      title="Search"
      description="Search indexed knowledge. Add a source filter when you only want matches from one named source."
    >
      <Field
        theme={theme}
        accessibilityLabel="Knowledge search query"
        label="Query"
        maxLength={1_024}
        onChangeText={setQuery}
        placeholder="What do you need to find?"
        value={query}
      />
      <Field
        theme={theme}
        accessibilityLabel="Knowledge search source filter"
        label="Source filter (optional)"
        maxLength={512}
        onChangeText={setSource}
        placeholder="docs, repository, or source label"
        value={source}
      />
      <LabeledChoices<SearchScope>
        theme={theme}
        label="Scope"
        accessibilityLabel={(option) => `Search ${option.label.toLowerCase()} scope`}
        onChange={setScope}
        options={SEARCH_SCOPES}
        value={scope}
      />
      <LabeledChoices<SearchSort>
        theme={theme}
        label="Order"
        accessibilityLabel={(option) => `Order results by ${option.label.toLowerCase()}`}
        onChange={setSort}
        options={SEARCH_SORTS}
        value={sort}
      />
      <ActionButton
        theme={theme}
        variant="primary"
        disabled={!canSearch || search.isPending || moreResults.isPending}
        label={search.isPending ? "Searching..." : "Search knowledge"}
        onPress={startSearch}
      />
      <ResultPanel
        theme={theme}
        emptyLabel="No matching knowledge"
        error={search.error}
        pending={search.isPending}
        result={search.data}
        source={request?.source}
      />
      {extraPages.map((page, pageIndex) => (
        <View
          key={`${page.completedAt}:${pageIndex}`}
          accessibilityLiveRegion="polite"
          style={styles.result}
        >
          <Text style={styles.metaLabel}>Page {pageIndex + 2}</Text>
          <OutputFrame theme={theme} output={page.output} emptyLabel="No more matches" />
        </View>
      ))}
      {nextPage && !search.isPending ? (
        <ActionButton
          theme={theme}
          accessibilityLabel="Load more search results"
          disabled={moreResults.isPending}
          label={moreResults.isPending ? "Loading..." : "More results"}
          onPress={loadMore}
        />
      ) : null}
      <ErrorText theme={theme} error={moreResults.error} />
    </WorkflowCard>
  );
}

function SourceManagement(props: WorkflowProps) {
  return (
    <>
      <IndexPathCard {...props} />
      <IndexUrlCard {...props} />
      <PurgeCard {...props} />
    </>
  );
}

function IndexPathCard({ theme, hostId, destination }: WorkflowProps) {
  const indexPath = useRpc(indexContextModePath);
  const refreshAnalytics = useRefreshAnalytics(hostId);
  const [path, setPath] = useState("");
  const index = useMutation({
    mutationKey: knowledgeMutationKey(hostId),
    mutationFn: (input: IndexPathInput) => indexPath(input),
    onSuccess: refreshAnalytics,
  });
  const target = path.trim();

  function submit() {
    if (destination) index.mutate({ ...destination, path: target });
  }

  return (
    <WorkflowCard
      theme={theme}
      title="Index a local path"
      description="Add a file or directory inside the selected project."
    >
      <Field
        theme={theme}
        accessibilityLabel="Local path to index"
        label="Local path"
        maxLength={4_096}
        onChangeText={setPath}
        placeholder="/absolute/path/to/docs"
        value={path}
      />
      <ActionButton
        theme={theme}
        disabled={!destination || !target || index.isPending}
        label={index.isPending ? "Indexing..." : "Index path"}
        onPress={submit}
      />
      <ResultPanel
        theme={theme}
        emptyLabel="No report"
        error={index.error}
        pending={index.isPending}
        result={index.data}
        source={index.variables?.path}
      />
    </WorkflowCard>
  );
}

function IndexUrlCard({ theme, hostId, destination }: WorkflowProps) {
  const fetchAndIndex = useRpc(fetchAndIndexContextMode);
  const refreshAnalytics = useRefreshAnalytics(hostId);
  const [url, setUrl] = useState("");
  const fetch = useMutation({
    mutationKey: knowledgeMutationKey(hostId),
    mutationFn: (input: FetchAndIndexInput) => fetchAndIndex(input),
    onSuccess: refreshAnalytics,
  });
  const target = url.trim();

  function submit() {
    if (destination) fetch.mutate({ ...destination, url: target });
  }

  return (
    <WorkflowCard
      theme={theme}
      title="Index a URL"
      description="Fetch one public HTTP or HTTPS page and add it to the selected project store."
    >
      <Field
        theme={theme}
        accessibilityLabel="URL to fetch and index"
        label="URL"
        maxLength={4_096}
        onChangeText={setUrl}
        placeholder="https://docs.example.com/guide"
        value={url}
      />
      <ActionButton
        theme={theme}
        disabled={!destination || !target || fetch.isPending}
        label={fetch.isPending ? "Indexing..." : "Index URL"}
        onPress={submit}
      />
      <ResultPanel
        theme={theme}
        emptyLabel="No report"
        error={fetch.error}
        pending={fetch.isPending}
        result={fetch.data}
        source={fetch.variables?.url}
      />
    </WorkflowCard>
  );
}

function purgeTargetFor(
  scope: PurgeScope | null,
  sessionId: string,
  source: string,
): PurgeTarget | null {
  if (scope === "project") return { scope };
  if (scope === "session" && sessionId) return { scope, sessionId };
  if (scope === "source" && source) return { scope, source };
  return null;
}

function PurgeCard({ theme, hostId, destination }: WorkflowProps) {
  const purgeKnowledge = useRpc(purgeContextModeKnowledge);
  const refreshAnalytics = useRefreshAnalytics(hostId);
  const [scope, setScope] = useState<PurgeScope | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [source, setSource] = useState("");
  // The armed review names one exact destination and target; editing either disarms it.
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const purge = useMutation({
    mutationKey: knowledgeMutationKey(hostId),
    mutationFn: (input: PurgeKnowledgeInput) => purgeKnowledge(input),
    onSuccess: refreshAnalytics,
    onSettled: () => setArmedFor(null),
  });
  const target = purgeTargetFor(scope, sessionId.trim(), source.trim());
  const reviewKey = JSON.stringify([destination, target]);
  const armed = armedFor === reviewKey;

  function changeScope(next: PurgeScope) {
    setScope(next);
    purge.reset();
  }

  function confirm() {
    if (destination && target) purge.mutate({ ...destination, confirm: true, ...target });
  }

  return (
    <WorkflowCard
      theme={theme}
      title="Purge knowledge"
      description="Purge part of the selected project store for every agent. Select a scope, review it, then confirm."
    >
      <LabeledChoices
        theme={theme}
        label="Scope"
        accessibilityLabel={(option) => `Purge ${option.label.toLowerCase()} scope`}
        onChange={changeScope}
        options={PURGE_SCOPES}
        value={scope}
      />
      {scope === "session" ? (
        <Field
          theme={theme}
          accessibilityLabel="Session identifier to purge"
          label="Session ID"
          maxLength={256}
          onChangeText={setSessionId}
          placeholder="Exact Context Mode session ID"
          value={sessionId}
        />
      ) : null}
      {scope === "source" ? (
        <Field
          theme={theme}
          accessibilityLabel="Source label to forget"
          label="Source label"
          maxLength={512}
          onChangeText={setSource}
          placeholder="Exact indexed source label"
          value={source}
        />
      ) : null}
      {armed && destination && target ? (
        <ConfirmPanel
          theme={theme}
          message={`Delete ${describePurgeTarget(target)} from the ${destination.projectPath} store? ${PURGE_CONSEQUENCE[target.scope]}`}
          confirmLabel="Confirm purge"
          pendingLabel="Purging..."
          pending={purge.isPending}
          onConfirm={confirm}
          onCancel={() => setArmedFor(null)}
        />
      ) : (
        <ActionButton
          theme={theme}
          variant="outline"
          disabled={!destination || !target || purge.isPending}
          label="Review purge"
          onPress={() => setArmedFor(reviewKey)}
        />
      )}
      <ResultPanel
        theme={theme}
        emptyLabel="Purged"
        error={purge.error}
        pending={purge.isPending}
        result={purge.data}
      />
    </WorkflowCard>
  );
}

interface ForgetButtonProps extends Pick<PluginSurfaceProps, "theme" | "host"> {
  provider: string;
  projectPath: string;
}

interface ForgetProps extends ForgetButtonProps {
  target: ForgetTarget;
}

/** Per-row "Forget" with the same review-then-confirm step as purge. */
function ForgetButton({ theme, host, provider, projectPath, target }: ForgetProps) {
  const purgeKnowledge = useRpc(purgeContextModeKnowledge);
  const refreshAnalytics = useRefreshAnalytics(host.id);
  const [armed, setArmed] = useState(false);
  const forget = useMutation({
    mutationFn: (input: PurgeKnowledgeInput) => purgeKnowledge(input),
    onSuccess: refreshAnalytics,
    onSettled: () => setArmed(false),
  });
  const targetLabel = describePurgeTarget(target);
  const mutedStyle = createStyles(theme).muted;

  if (forget.isSuccess) return <Text style={mutedStyle}>Forgotten</Text>;
  return (
    <View style={{ gap: 4 }}>
      {armed ? (
        <ConfirmPanel
          theme={theme}
          message={`Forget ${targetLabel} from the ${projectPath} store? ${PURGE_CONSEQUENCE[target.scope]}`}
          confirmAccessibilityLabel={`Confirm forget ${targetLabel}`}
          confirmLabel="Confirm forget"
          pendingLabel="Forgetting..."
          pending={forget.isPending}
          onConfirm={() => forget.mutate({ provider, projectPath, confirm: true, ...target })}
          onCancel={() => setArmed(false)}
        />
      ) : (
        <ActionButton
          theme={theme}
          variant="outline"
          accessibilityLabel={`Forget ${targetLabel}`}
          label="Forget"
          onPress={() => setArmed(true)}
        />
      )}
      <ErrorText theme={theme} error={forget.error} />
    </View>
  );
}

interface ForgetSourceButtonProps extends ForgetButtonProps {
  source: string;
}

/** Forgets one indexed source from the project store. */
export function ForgetSourceButton({ source, ...props }: ForgetSourceButtonProps) {
  return <ForgetButton {...props} target={{ scope: "source", source }} />;
}

interface ForgetSessionButtonProps extends ForgetButtonProps {
  sessionId: string;
}

/** Forgets one recorded session's events from the project store. */
export function ForgetSessionButton({ sessionId, ...props }: ForgetSessionButtonProps) {
  return <ForgetButton {...props} target={{ scope: "session", sessionId }} />;
}
