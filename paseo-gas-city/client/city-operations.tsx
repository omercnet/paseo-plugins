import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import {
  type AttentionItem,
  type DispatchRequest,
  dispatchWork,
  type GasCityConvoy,
  type GasCityEvent,
  type GasCitySession,
  type GasCitySettings,
  type GasCityWorkItem,
  getCityRigSnapshot,
  listAttention,
  listConvoys,
  listEvents,
  listSessions,
  listWork,
  performSessionAction,
  type SessionActionRequest,
  toGasCityRpcSettings,
} from "../shared";
import type { SlingIntent } from "./dispatch-intent";
import {
  buildDashboardSections,
  cityQueryRoot,
  convoyProgress,
  type DashboardRow,
  type DashboardSection,
  presentSection,
  refreshPresentation,
  type SessionActionName,
  sessionAccessibilityLabel,
  sessionActionsFor,
} from "./view-model";

interface CityOperationsProps extends PluginHostProps {
  cityName: string;
  rigName: string | null;
  settings: GasCitySettings;
  slingIntent?: SlingIntent | null;
  onDismissSlingIntent?: (id: number) => void;
}

type SessionAction = SessionActionName | "respond";
type InteractionResponse = "allow" | "deny" | "answer";
type SessionActionDialog = {
  sessionId: string;
  title: string;
  actions: readonly SessionAction[];
  requestId: string | null;
};
type Styles = Record<string, TextStyle | ViewStyle>;

const SESSION_ACTION_LABELS: Record<SessionAction, string> = {
  wake: "Wake",
  message: "Message",
  submit: "Submit",
  stop: "Stop",
  suspend: "Suspend",
  close: "Close",
  kill: "Kill",
  respond: "Respond",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function relativeTime(value: string | null): string {
  if (!value) return "never";
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return value;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusColor(status: string, colors: PluginHostProps["theme"]["colors"]): string {
  const normalized = status.toLowerCase();
  if (/error|failed|critical|kill|quarantined/.test(normalized)) return colors.statusDanger;
  if (/warn|blocked|pending|suspend|stale/.test(normalized)) return colors.statusWarning;
  if (/running|active|ready|available|complete|success/.test(normalized)) {
    return colors.statusSuccess;
  }
  return colors.foregroundMuted;
}

function StateCard({
  body,
  loading,
  onRetry,
  styles,
  theme,
  title,
}: {
  body: string;
  loading?: boolean;
  onRetry?: () => void;
  styles: Styles;
  theme: PluginHostProps["theme"];
  title: string;
}) {
  return (
    <View style={styles.stateCard}>
      {loading ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <Icon name="AlertTriangle" size={24} color={theme.colors.foregroundMuted} />
      )}
      <Text accessibilityRole="header" style={styles.stateTitle}>
        {title}
      </Text>
      <Text style={styles.stateBody}>{body}</Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading Gas City data"
          onPress={onRetry}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryButtonText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Stat({ label, value, styles }: { label: string; value: string | number; styles: Styles }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Diagnostics({
  diagnostics,
  styles,
  theme,
}: {
  diagnostics: readonly { code: string; message: string; retryable: boolean }[];
  styles: Styles;
  theme: PluginHostProps["theme"];
}) {
  if (diagnostics.length === 0) return null;
  return (
    <View accessibilityRole="alert" style={styles.diagnostics}>
      <View style={styles.diagnosticsTitleRow}>
        <Icon name="TriangleAlert" size={15} color={theme.colors.statusWarning} />
        <Text style={styles.diagnosticsTitle}>Diagnostics</Text>
      </View>
      {diagnostics.map((diagnostic) => (
        <Text key={`${diagnostic.code}:${diagnostic.message}`} style={styles.diagnosticText}>
          {diagnostic.code}: {diagnostic.message}
          {diagnostic.retryable ? " · retryable" : ""}
        </Text>
      ))}
    </View>
  );
}

function AttentionRow({
  item,
  onRespond,
  styles,
  theme,
}: {
  item: AttentionItem;
  onRespond?: () => void;
  styles: Styles;
  theme: PluginHostProps["theme"];
}) {
  return (
    <View
      accessibilityLabel={`${item.severity} attention: ${item.title}. ${item.message}`}
      style={styles.row}
    >
      <View
        style={[styles.statusRail, { backgroundColor: statusColor(item.severity, theme.colors) }]}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[styles.badgeText, { color: statusColor(item.severity, theme.colors) }]}>
            {item.severity}
          </Text>
        </View>
        <Text style={styles.rowMessage} numberOfLines={2}>
          {item.message}
        </Text>
        <Text style={styles.rowMeta}>
          {item.kind} · {item.code} · {relativeTime(item.observedAt)}
        </Text>
        {onRespond ? (
          <View style={styles.rowActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Respond to ${item.title}`}
              onPress={onRespond}
              style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
            >
              <Icon name="MessageSquareReply" size={13} color={theme.colors.foreground} />
              <Text style={styles.inlineButtonText}>Respond</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ConvoyRow({
  item,
  styles,
  theme,
}: {
  item: GasCityConvoy;
  styles: Styles;
  theme: PluginHostProps["theme"];
}) {
  return (
    <View
      accessibilityLabel={`${item.title}. ${item.status}. ${convoyProgress(item)}.`}
      style={styles.row}
    >
      <View
        style={[
          styles.statusRail,
          { backgroundColor: statusColor(item.blocked ? "blocked" : item.status, theme.colors) },
        ]}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.badgeText}>
            {item.priority === null ? "P–" : `P${item.priority}`}
          </Text>
        </View>
        <Text style={styles.rowMessage}>{convoyProgress(item)}</Text>
        <Text style={styles.rowMeta}>
          {item.id} · {item.assignee ?? "unassigned"} · {item.status}
        </Text>
      </View>
    </View>
  );
}

function WorkRow({
  item,
  styles,
  theme,
}: {
  item: GasCityWorkItem;
  styles: Styles;
  theme: PluginHostProps["theme"];
}) {
  return (
    <View accessibilityLabel={`${item.title}. ${item.status}. ${item.type}.`} style={styles.row}>
      <View
        style={[
          styles.statusRail,
          { backgroundColor: statusColor(item.blocked ? "blocked" : item.status, theme.colors) },
        ]}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.badgeText}>
            {item.priority === null ? "P–" : `P${item.priority}`}
          </Text>
        </View>
        <Text style={styles.rowMessage} numberOfLines={1}>
          {item.id} · {item.type}
        </Text>
        <Text style={styles.rowMeta}>
          {item.assignee ?? "unassigned"} · {item.status}
        </Text>
      </View>
    </View>
  );
}

function EventRow({
  item,
  styles,
  theme,
}: {
  item: GasCityEvent;
  styles: Styles;
  theme: PluginHostProps["theme"];
}) {
  return (
    <View
      accessibilityLabel={`${item.type}. ${item.message ?? "No message"}. ${relativeTime(item.timestamp)}.`}
      style={styles.row}
    >
      <View style={[styles.eventMarker, { borderColor: theme.colors.accent }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.type}
          </Text>
          <Text style={styles.sequence}>#{item.sequence}</Text>
        </View>
        {item.message ? (
          <Text style={styles.rowMessage} numberOfLines={2}>
            {item.message}
          </Text>
        ) : null}
        <Text style={styles.rowMeta}>
          {item.actor ?? "system"} · {relativeTime(item.timestamp)}
        </Text>
      </View>
    </View>
  );
}

export function CityOperations({
  theme,
  layout,
  host,
  cityName,
  rigName,
  settings,
  slingIntent,
  onDismissSlingIntent,
}: CityOperationsProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const toast = useToast();
  const queryClient = useQueryClient();
  const loadSnapshot = useRpc(getCityRigSnapshot);
  const loadSessions = useRpc(listSessions);
  const loadConvoys = useRpc(listConvoys);
  const loadWork = useRpc(listWork);
  const loadEvents = useRpc(listEvents);
  const loadAttention = useRpc(listAttention);
  const runDispatch = useRpc(dispatchWork);
  const runSessionAction = useRpc(performSessionAction);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchBeadId, setDispatchBeadId] = useState("");
  const [dispatchAgent, setDispatchAgent] = useState("");
  const [dispatchDraftError, setDispatchDraftError] = useState<string | null>(null);
  const [sessionDialog, setSessionDialog] = useState<SessionActionDialog | null>(null);
  const [sessionAction, setSessionAction] = useState<SessionAction>("message");
  const [sessionMessage, setSessionMessage] = useState("");
  const [interactionResponse, setInteractionResponse] = useState<InteractionResponse>("allow");
  const rpcSettings = useMemo(() => toGasCityRpcSettings(settings), [settings]);

  useEffect(() => {
    if (!slingIntent) return;
    setDispatchBeadId(slingIntent.beadId);
    setDispatchAgent(slingIntent.agent);
    setDispatchDraftError(slingIntent.parseError);
    setDispatchOpen(true);
    onDismissSlingIntent?.(slingIntent.id);
  }, [onDismissSlingIntent, slingIntent]);

  const scope = useMemo(
    () => ({ settings: rpcSettings, cityName, rigName }),
    [cityName, rigName, rpcSettings],
  );
  const queryRoot = useMemo(
    () => cityQueryRoot(host.id, settings.endpointUrl, cityName, rigName),
    [cityName, host.id, rigName, settings.endpointUrl],
  );
  const snapshotQuery = useQuery({
    queryKey: [...queryRoot, "snapshot"],
    queryFn: () => loadSnapshot(scope),
    refetchInterval: settings.refreshIntervalMs,
  });
  const sessionsQuery = useQuery({
    queryKey: [...queryRoot, "sessions"],
    queryFn: () => loadSessions(scope),
    refetchInterval: settings.refreshIntervalMs,
  });
  const convoysQuery = useQuery({
    queryKey: [...queryRoot, "convoys"],
    queryFn: () => loadConvoys(scope),
    refetchInterval: settings.refreshIntervalMs,
  });
  const workQuery = useQuery({
    queryKey: [...queryRoot, "work", settings.eventLimit],
    queryFn: () => loadWork(scope),
    refetchInterval: settings.refreshIntervalMs,
  });
  const eventsQuery = useQuery({
    queryKey: [...queryRoot, "events", settings.eventLimit],
    queryFn: () => loadEvents({ settings: rpcSettings, scope: "city", cityName, cursor: null }),
    refetchInterval: settings.refreshIntervalMs,
  });
  const attentionQuery = useQuery({
    queryKey: [...queryRoot, "attention"],
    queryFn: () => loadAttention(scope),
    refetchInterval: settings.refreshIntervalMs,
  });

  const baseSections = useMemo(
    () =>
      buildDashboardSections({
        attention: attentionQuery.data,
        sessions: sessionsQuery.data,
        convoys: convoysQuery.data,
        work: workQuery.data,
        events: eventsQuery.data,
      }),
    [attentionQuery.data, convoysQuery.data, eventsQuery.data, sessionsQuery.data, workQuery.data],
  );
  const sections = useMemo(() => {
    const queries = [attentionQuery, sessionsQuery, convoysQuery, workQuery, eventsQuery];
    return baseSections.map((section, index) => {
      const query = queries[index];
      return presentSection(section, {
        hasData: query.data !== undefined,
        isPending: query.isPending,
        isFetching: query.isFetching,
        error: query.error,
      });
    });
  }, [attentionQuery, baseSections, convoysQuery, eventsQuery, sessionsQuery, workQuery]);

  const refresh = refreshPresentation({
    hasData: snapshotQuery.data !== undefined,
    isPending: snapshotQuery.isPending,
    isFetching:
      snapshotQuery.isFetching ||
      sessionsQuery.isFetching ||
      convoysQuery.isFetching ||
      workQuery.isFetching ||
      eventsQuery.isFetching ||
      attentionQuery.isFetching,
    error:
      snapshotQuery.error ??
      sessionsQuery.error ??
      convoysQuery.error ??
      workQuery.error ??
      eventsQuery.error ??
      attentionQuery.error,
    refreshedAt: snapshotQuery.data?.refreshedAt,
  });

  const dispatchMutation = useMutation({
    mutationFn: async () => {
      if (!settings.mutationsEnabled) {
        throw new Error("Enable mutations in Gas City settings first.");
      }
      const beadId = dispatchBeadId.trim();
      const agent = dispatchAgent.trim();
      if (!beadId || !agent) throw new Error("Bead ID and agent role are required.");
      const request = {
        kind: "bead",
        confirmed: true,
        target: { cityName, rigName, agent },
        beadId,
        reassign: false,
        owned: false,
        force: false,
        noFormula: false,
        noConvoy: false,
        merge: "direct",
      } satisfies DispatchRequest;
      return runDispatch({ settings: rpcSettings, request });
    },
    onSuccess: (result) => {
      toast.show(`Dispatched ${result.beadId ?? "work"} to ${result.target}.`, {
        variant: "success",
      });
      setDispatchOpen(false);
      setDispatchBeadId("");
      setDispatchAgent("");
      setDispatchDraftError(null);
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryRoot });
    },
  });

  const sessionMutation = useMutation({
    mutationFn: async () => {
      if (!settings.mutationsEnabled) {
        throw new Error("Enable mutations in Gas City settings first.");
      }
      if (!sessionDialog) throw new Error("Choose a session first.");
      const base = { cityName, sessionId: sessionDialog.sessionId, confirmed: true as const };
      let request: SessionActionRequest;
      if (sessionAction === "message") {
        request = { ...base, action: "message", message: sessionMessage.trim() };
      } else if (sessionAction === "submit") {
        request = {
          ...base,
          action: "submit",
          message: sessionMessage.trim(),
          intent: "follow_up",
        };
      } else if (sessionAction === "respond") {
        if (!sessionDialog.requestId) throw new Error("Pending interaction request ID is missing.");
        request = {
          ...base,
          action: "respond",
          requestId: sessionDialog.requestId,
          response: interactionResponse,
          text: interactionResponse === "answer" ? sessionMessage.trim() : null,
          metadata: {},
        };
      } else {
        request = { ...base, action: sessionAction };
      }
      return runSessionAction({ settings: rpcSettings, request });
    },
    onSuccess: (result) => {
      toast.show(`${sessionAction} accepted for ${result.sessionId}.`, { variant: "success" });
      setSessionDialog(null);
      setSessionMessage("");
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryRoot });
    },
  });

  async function refreshAll() {
    await Promise.all([
      snapshotQuery.refetch(),
      sessionsQuery.refetch(),
      convoysQuery.refetch(),
      workQuery.refetch(),
      eventsQuery.refetch(),
      attentionQuery.refetch(),
    ]);
  }

  function openSessionActions(session: GasCitySession) {
    const actions = sessionActionsFor(session);
    const firstAction = actions[0];
    if (!firstAction) return;
    setSessionDialog({
      sessionId: session.id,
      title: session.title,
      actions,
      requestId: null,
    });
    setSessionAction(firstAction);
    setSessionMessage("");
  }

  function openInteractionResponse(item: AttentionItem) {
    if (!item.resourceId || !item.requestId) return;
    setSessionDialog({
      sessionId: item.resourceId,
      title: item.title,
      actions: ["respond"],
      requestId: item.requestId,
    });
    setSessionAction("respond");
    setInteractionResponse("allow");
    setSessionMessage("");
  }

  function renderSession(item: GasCitySession) {
    const actions = sessionActionsFor(item);
    return (
      <View accessibilityLabel={sessionAccessibilityLabel(item)} style={styles.row}>
        <View
          style={[
            styles.statusRail,
            { backgroundColor: statusColor(item.running ? "running" : item.state, theme.colors) },
          ]}
        />
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={[styles.badgeText, { color: statusColor(item.state, theme.colors) }]}>
              {item.state}
            </Text>
          </View>
          <Text style={styles.rowMessage} numberOfLines={1}>
            {item.sessionName} · {item.provider}
            {item.model ? ` / ${item.model}` : ""}
          </Text>
          <Text style={styles.rowMeta}>
            {item.rigName ?? "city"} · {item.activity ?? "idle"} · {relativeTime(item.lastActiveAt)}
          </Text>
          <View style={styles.rowActions}>
            {actions.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open actions for ${item.title}`}
                onPress={() => openSessionActions(item)}
                style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
              >
                <Icon name="SlidersHorizontal" size={13} color={theme.colors.foreground} />
                <Text style={styles.inlineButtonText}>Actions</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  function renderRow({ item }: { item: DashboardRow }) {
    if (item.kind === "status") {
      return (
        <View
          accessibilityRole={item.tone === "error" || item.tone === "stale" ? "alert" : undefined}
          style={styles.inlineState}
        >
          {item.tone === "loading" || item.tone === "refreshing" ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <Icon
              name="AlertTriangle"
              size={14}
              color={item.tone === "error" ? theme.colors.statusDanger : theme.colors.statusWarning}
            />
          )}
          <Text style={styles.inlineStateText}>{item.message}</Text>
        </View>
      );
    }
    if (item.kind === "empty") return <Text style={styles.emptyText}>{item.message}</Text>;
    if (item.kind === "attention") {
      const canRespond = Boolean(item.item.requestId && item.item.resourceId);
      return (
        <AttentionRow
          item={item.item}
          onRespond={canRespond ? () => openInteractionResponse(item.item) : undefined}
          styles={styles}
          theme={theme}
        />
      );
    }
    if (item.kind === "session") return renderSession(item.item);
    if (item.kind === "convoy") return <ConvoyRow item={item.item} styles={styles} theme={theme} />;
    if (item.kind === "work") return <WorkRow item={item.item} styles={styles} theme={theme} />;
    return <EventRow item={item.item} styles={styles} theme={theme} />;
  }

  const snapshot = snapshotQuery.data;
  let body: ReactNode;
  if (snapshotQuery.isPending && !snapshot) {
    body = (
      <StateCard
        title="Loading city operations"
        body="Reading the city, rig, and work state."
        loading
        styles={styles}
        theme={theme}
      />
    );
  } else if (snapshotQuery.error && !snapshot) {
    body = (
      <StateCard
        title="Could not load city operations"
        body={errorMessage(snapshotQuery.error)}
        onRetry={() => void refreshAll()}
        styles={styles}
        theme={theme}
      />
    );
  } else if (!snapshot) {
    body = (
      <StateCard
        title="No city snapshot"
        body="The supervisor returned no usable city data."
        onRetry={() => void refreshAll()}
        styles={styles}
        theme={theme}
      />
    );
  } else {
    const header = (
      <View style={styles.summary}>
        <View style={styles.summaryHeading}>
          <View style={styles.summaryTitleBlock}>
            <Text style={styles.eyebrow}>
              {rigName ? "Mapped production line" : "City operations"}
            </Text>
            <Text accessibilityRole="header" style={styles.cityTitle}>
              {cityName}
            </Text>
            <Text style={styles.summaryMeta}>
              {snapshot.city.status ?? (snapshot.city.running ? "running" : "stopped")} ·{" "}
              {rigName ?? `${snapshot.rigs.length} rigs`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open confirmed Gas City dispatch"
            onPress={() => setDispatchOpen(true)}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          >
            <Icon name="Send" size={14} color={theme.colors.accentForeground} />
            <Text style={styles.primaryButtonText}>Sling</Text>
          </Pressable>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.statsRail}
        >
          <Stat
            label="city-wide agents"
            value={`${snapshot.city.agents.running}/${snapshot.city.agents.total}`}
            styles={styles}
          />
          <Stat label="city-wide sessions" value={snapshot.city.sessions.active} styles={styles} />
          <Stat label="city-wide ready" value={snapshot.city.work.ready} styles={styles} />
          <Stat
            label="city-wide in progress"
            value={snapshot.city.work.inProgress}
            styles={styles}
          />
          <Stat label="city-wide open" value={snapshot.city.work.open} styles={styles} />
        </ScrollView>
        {snapshot.rig ? (
          <View style={styles.rigCard}>
            <View>
              <Text style={styles.rigName}>{snapshot.rig.name}</Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {snapshot.rig.path}
                {snapshot.rig.git
                  ? ` · ${snapshot.rig.git.branch}${snapshot.rig.git.clean ? "" : "*"}`
                  : ""}
              </Text>
            </View>
            <Text
              style={[
                styles.badgeText,
                {
                  color: statusColor(
                    snapshot.rig.suspended ? "suspended" : "running",
                    theme.colors,
                  ),
                },
              ]}
            >
              {snapshot.rig.suspended
                ? "suspended"
                : `${snapshot.rig.runningAgentCount}/${snapshot.rig.agentCount} agents`}
            </Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rigRail}
          >
            {snapshot.rigs.map((rig) => (
              <View key={`${rig.path}:${rig.name}`} style={styles.rigPill}>
                <View
                  style={[
                    styles.rigDot,
                    {
                      backgroundColor: statusColor(
                        rig.suspended ? "suspended" : "running",
                        theme.colors,
                      ),
                    },
                  ]}
                />
                <Text style={styles.rigPillText}>
                  {rig.name} · {rig.runningAgentCount}/{rig.agentCount}
                </Text>
              </View>
            ))}
            {snapshot.rigs.length === 0 ? (
              <Text style={styles.emptyText}>No rigs reported.</Text>
            ) : null}
          </ScrollView>
        )}
        {snapshot.partial ? (
          <View accessibilityRole="alert" style={styles.partialNotice}>
            <Icon name="TriangleAlert" size={14} color={theme.colors.statusWarning} />
            <Text style={styles.partialText}>
              Partial snapshot. Some supervisor data is unavailable.
            </Text>
          </View>
        ) : null}
        <Diagnostics diagnostics={snapshot.diagnostics} styles={styles} theme={theme} />
      </View>
    );

    body = (
      <SectionList<DashboardRow, DashboardSection>
        style={styles.list}
        contentContainerStyle={styles.listContent}
        sections={sections}
        keyExtractor={(item, index) => {
          if (item.kind === "attention") return `attention:${item.item.id}`;
          if (item.kind === "session") return `session:${item.item.id}`;
          if (item.kind === "convoy") return `convoy:${item.item.id}`;
          if (item.kind === "work") return `work:${item.item.id}`;
          if (item.kind === "event")
            return `event:${item.item.cityName ?? "global"}:${item.item.sequence}`;
          return `${item.kind}:${index}:${item.message}`;
        }}
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={7}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {section.title}
            </Text>
            {section.truncated ? <Text style={styles.truncated}>bounded result</Text> : null}
          </View>
        )}
        renderItem={renderRow}
      />
    );
  }

  const messageRequired =
    sessionAction === "message" ||
    sessionAction === "submit" ||
    (sessionAction === "respond" && interactionResponse === "answer");
  const sessionConfirmDisabled =
    !settings.mutationsEnabled ||
    sessionMutation.isPending ||
    (messageRequired && sessionMessage.trim().length === 0);

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.liveLabel}>
          <View
            style={[
              styles.liveDot,
              {
                backgroundColor:
                  refresh.state === "error" || refresh.state === "stale"
                    ? theme.colors.statusWarning
                    : theme.colors.statusSuccess,
              },
            ]}
          />
          <Text style={styles.refreshText} numberOfLines={1}>
            {refresh.label}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh all Gas City data"
          onPress={() => void refreshAll()}
          style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
        >
          <Icon
            name="RefreshCw"
            size={14}
            color={refresh.state === "refreshing" ? theme.colors.accent : theme.colors.foreground}
          />
          {!layout.compact ? <Text style={styles.refreshButtonText}>Refresh</Text> : null}
        </Pressable>
      </View>
      <View style={styles.body}>{body}</View>

      <Modal
        title="Confirm Gas City dispatch"
        open={dispatchOpen}
        onOpenChange={(open) => {
          if (!open && !dispatchMutation.isPending) setDispatchOpen(false);
        }}
        icon={<Icon name="Send" size={18} color={theme.colors.foreground} />}
      >
        <Modal.Content>
          <View style={styles.modalBody}>
            <Text style={styles.modalCopy}>
              Dispatch one bead to a generic Gas City agent role in {cityName}
              {rigName ? ` / ${rigName}` : ""}.
            </Text>
            {!settings.mutationsEnabled ? (
              <View accessibilityRole="alert" style={styles.lockedNotice}>
                <Icon name="Lock" size={15} color={theme.colors.statusWarning} />
                <Text style={styles.lockedText}>
                  Observe-only mode. Enable mutations in persisted Gas City settings to dispatch
                  work.
                </Text>
              </View>
            ) : null}
            {dispatchDraftError ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {dispatchDraftError}
              </Text>
            ) : null}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Bead ID</Text>
              <TextInput
                accessibilityLabel="Gas City bead ID"
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => {
                  setDispatchBeadId(value);
                  setDispatchDraftError(null);
                }}
                placeholder="gc-123"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={dispatchBeadId}
                style={styles.textInput}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Agent role</Text>
              <TextInput
                accessibilityLabel="Gas City agent role"
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => {
                  setDispatchAgent(value);
                  setDispatchDraftError(null);
                }}
                placeholder="city/role"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={dispatchAgent}
                style={styles.textInput}
              />
            </View>
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                disabled={dispatchMutation.isPending}
                onPress={() => setDispatchOpen(false)}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Confirm Gas City dispatch"
                disabled={
                  !settings.mutationsEnabled ||
                  dispatchMutation.isPending ||
                  !dispatchBeadId.trim() ||
                  !dispatchAgent.trim()
                }
                onPress={() => dispatchMutation.mutate()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.pressed,
                  (!settings.mutationsEnabled ||
                    dispatchMutation.isPending ||
                    !dispatchBeadId.trim() ||
                    !dispatchAgent.trim()) &&
                    styles.disabled,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {dispatchMutation.isPending ? "Dispatching…" : "Confirm dispatch"}
                </Text>
              </Pressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title={sessionDialog ? `Confirm action: ${sessionDialog.title}` : "Confirm session action"}
        open={sessionDialog !== null}
        onOpenChange={(open) => {
          if (!open && !sessionMutation.isPending) setSessionDialog(null);
        }}
        icon={<Icon name="SlidersHorizontal" size={18} color={theme.colors.foreground} />}
      >
        <Modal.Content>
          <View style={styles.modalBody}>
            {!settings.mutationsEnabled ? (
              <View accessibilityRole="alert" style={styles.lockedNotice}>
                <Icon name="Lock" size={15} color={theme.colors.statusWarning} />
                <Text style={styles.lockedText}>
                  Observe-only mode. Enable mutations in persisted Gas City settings to operate
                  sessions.
                </Text>
              </View>
            ) : null}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.actionRail}
            >
              {(sessionDialog?.actions ?? []).map((action) => {
                const selected = sessionAction === action;
                const label = SESSION_ACTION_LABELS[action];
                return (
                  <Pressable
                    key={action}
                    accessibilityRole="button"
                    accessibilityLabel={`${label} session`}
                    accessibilityState={{ selected }}
                    onPress={() => setSessionAction(action)}
                    style={({ pressed }) => [
                      styles.actionChip,
                      selected && styles.actionChipSelected,
                      action === "kill" && selected && styles.dangerChip,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={[styles.actionChipText, selected && styles.actionChipTextSelected]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {sessionAction === "respond" ? (
              <View style={styles.actionRail}>
                {(["allow", "deny", "answer"] as const).map((response) => {
                  const selected = interactionResponse === response;
                  return (
                    <Pressable
                      key={response}
                      accessibilityRole="button"
                      accessibilityLabel={`${response} pending interaction`}
                      accessibilityState={{ selected }}
                      onPress={() => setInteractionResponse(response)}
                      style={[styles.actionChip, selected && styles.actionChipSelected]}
                    >
                      <Text
                        style={[styles.actionChipText, selected && styles.actionChipTextSelected]}
                      >
                        {response}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {messageRequired ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>
                  {sessionAction === "submit"
                    ? "Follow-up prompt"
                    : sessionAction === "respond"
                      ? "Response"
                      : "Message"}
                </Text>
                <TextInput
                  accessibilityLabel={
                    sessionAction === "submit"
                      ? "Session follow-up prompt"
                      : sessionAction === "respond"
                        ? "Interaction response"
                        : "Session message"
                  }
                  multiline
                  onChangeText={setSessionMessage}
                  placeholder="Give the session its next instruction"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={sessionMessage}
                  style={[styles.textInput, styles.multilineInput]}
                />
              </View>
            ) : (
              <Text style={styles.modalCopy}>
                This sends a confirmed {sessionAction} action to the selected Gas City session.
              </Text>
            )}
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                disabled={sessionMutation.isPending}
                onPress={() => setSessionDialog(null)}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Confirm ${sessionAction} session action`}
                disabled={sessionConfirmDisabled}
                onPress={() => sessionMutation.mutate()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  sessionAction === "kill" && styles.dangerButton,
                  pressed && styles.pressed,
                  sessionConfirmDisabled && styles.disabled,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {sessionMutation.isPending ? "Working…" : `Confirm ${sessionAction}`}
                </Text>
              </Pressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function createStyles(theme: PluginHostProps["theme"], compact: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    toolbar: {
      minHeight: 42,
      paddingHorizontal: compact ? 12 : 18,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    liveLabel: { minWidth: 0, flex: 1, flexDirection: "row", alignItems: "center", gap: 7 },
    liveDot: { width: 7, height: 7, borderRadius: 4 },
    refreshText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 11 },
    refreshButton: {
      minHeight: 32,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 9,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    refreshButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    body: { flex: 1 },
    list: { flex: 1 },
    listContent: { paddingBottom: 24 },
    summary: {
      padding: compact ? 12 : 18,
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    summaryHeading: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    summaryTitleBlock: { flex: 1, minWidth: 0, gap: 2 },
    eyebrow: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    cityTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 20 : 24,
      fontWeight: "800",
      letterSpacing: -0.4,
    },
    summaryMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
    statsRail: { gap: 7 },
    stat: {
      minWidth: compact ? 78 : 94,
      gap: 2,
      paddingVertical: 9,
      paddingHorizontal: 11,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    statValue: { color: theme.colors.foreground, fontSize: 17, fontWeight: "800" },
    statLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "600",
      textTransform: "uppercase",
    },
    rigCard: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    rigName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
    rigRail: { gap: 7 },
    rigPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 7,
      paddingHorizontal: 9,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    rigDot: { width: 6, height: 6, borderRadius: 3 },
    rigPillText: { color: theme.colors.foreground, fontSize: 11, fontWeight: "600" },
    partialNotice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      padding: 9,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.statusWarning,
    },
    partialText: { flex: 1, color: theme.colors.statusWarning, fontSize: 11 },
    diagnostics: {
      gap: 5,
      padding: 10,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.statusWarning,
    },
    diagnosticsTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    diagnosticsTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "700" },
    diagnosticText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: compact ? 12 : 18,
      paddingTop: 18,
      paddingBottom: 7,
      backgroundColor: theme.colors.surface0,
    },
    sectionTitle: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "800",
      letterSpacing: 0.2,
    },
    truncated: { color: theme.colors.statusWarning, fontSize: 10, textTransform: "uppercase" },
    row: {
      marginHorizontal: compact ? 12 : 18,
      marginBottom: 6,
      minHeight: 70,
      flexDirection: "row",
      overflow: "hidden",
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    statusRail: { width: 3 },
    eventMarker: {
      width: 9,
      height: 9,
      marginLeft: 10,
      marginTop: 13,
      borderRadius: 5,
      borderWidth: 2,
    },
    rowBody: { flex: 1, minWidth: 0, gap: 3, padding: 10 },
    rowTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    rowTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
    rowMessage: { color: theme.colors.foreground, fontSize: 11, lineHeight: 16 },
    rowMeta: { color: theme.colors.foregroundMuted, fontSize: 10 },
    badgeText: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    sequence: { color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] },
    rowActions: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 5 },
    inlineButton: {
      minHeight: 30,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 8,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    inlineButtonText: { color: theme.colors.foreground, fontSize: 10, fontWeight: "600" },
    inlineState: {
      marginHorizontal: compact ? 12 : 18,
      marginBottom: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      padding: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    inlineStateText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 11 },
    emptyText: {
      marginHorizontal: compact ? 12 : 18,
      marginBottom: 6,
      padding: 14,
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      textAlign: "center",
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    stateCard: {
      margin: compact ? 12 : 18,
      padding: 22,
      alignItems: "center",
      gap: 8,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    stateTitle: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: "700",
      textAlign: "center",
    },
    stateBody: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
    },
    primaryButton: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 12,
      borderRadius: 7,
      backgroundColor: theme.colors.accent,
    },
    primaryButtonText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" },
    secondaryButton: {
      minHeight: 36,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 12,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    pressed: { opacity: 0.72 },
    disabled: { opacity: 0.42 },
    modalBody: { gap: 14 },
    modalCopy: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    modalActions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 },
    field: { gap: 6 },
    fieldLabel: { color: theme.colors.foreground, fontSize: 11, fontWeight: "700" },
    textInput: {
      minHeight: 40,
      paddingHorizontal: 11,
      paddingVertical: 9,
      color: theme.colors.foreground,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    multilineInput: { minHeight: 96, textAlignVertical: "top" },
    lockedNotice: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      padding: 10,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.statusWarning,
    },
    lockedText: { flex: 1, color: theme.colors.statusWarning, fontSize: 11, lineHeight: 16 },
    errorText: { color: theme.colors.statusDanger, fontSize: 11 },
    actionRail: { gap: 6 },
    actionChip: {
      minHeight: 34,
      justifyContent: "center",
      paddingHorizontal: 10,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    actionChipSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface2,
    },
    dangerChip: { borderColor: theme.colors.statusDanger },
    actionChipText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    actionChipTextSelected: { color: theme.colors.foreground },
    dangerButton: { backgroundColor: theme.colors.statusDanger },
  });
}
