import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { acknowledgeViewerScope, viewerScope } from "../shared/viewer-scope";
import {
  type AgentEntry,
  agentActionFor,
  applyViewerScope,
  BUCKET_TITLES,
  BUCKETS,
  buildAgentPrompt,
  buildRadarSnapshot,
  checkSummary,
  formatAge,
  hasActiveAgent,
  matchesRow,
  mergeInboxRows,
  type PaseoApi,
  type PaseoWorkspace,
  type RadarBucket,
  type RadarRow,
} from "./radar";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const BACKSTOP_REFRESH_MS = 60_000;
const EVENT_DEBOUNCE_MS = 500;
const CLOCK_TICK_MS = 30_000;

type SavedView = "security" | "updated" | "stale" | "automation";

const SAVED_VIEW_TITLES: Record<SavedView, string> = {
  security: "Security",
  updated: "Updated",
  stale: "Stale",
  automation: "Automation",
};

const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1_000;

async function loadAgents(paseo: PaseoApi): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return entries;
}

async function loadWorkspaces(paseo: PaseoApi): Promise<PaseoWorkspace[]> {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    workspaces.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return workspaces;
}

function bucketColor(bucket: RadarBucket, colors: PluginSurfaceProps["theme"]["colors"]): string {
  if (bucket === "needs-you") return colors.statusDanger;
  if (bucket === "ready") return colors.statusSuccess;
  if (bucket === "being-handled") return colors.accent;
  return colors.statusWarning;
}

function agentState(row: RadarRow): string {
  const agent = row.agents[0];
  if (!agent) return "No active agent";
  const extra = row.agents.length > 1 ? ` +${row.agents.length - 1}` : "";
  if (agent.pendingPermissions > 0) return `${agent.title} · permission${extra}`;
  if (agent.requiresAttention && agent.attentionReason !== "finished") {
    return `${agent.title} · needs input${extra}`;
  }
  return `${agent.title} · ${agent.status}${extra}`;
}

export function PrRadar({ theme, layout, host, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["pr-radar", host.id], [host.id]);
  const resolveViewerScope = useRpc(viewerScope);
  const acknowledgeUpdates = useRpc(acknowledgeViewerScope);
  const [selected, setSelected] = useState<RadarBucket | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [savedView, setSavedView] = useState<SavedView | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [openError, setOpenError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const {
    data,
    error,
    isPending,
    isFetching: isDirectoryFetching,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      const [workspaces, agents] = await Promise.all([loadWorkspaces(paseo), loadAgents(paseo)]);
      return buildRadarSnapshot(workspaces, agents);
    },
    refetchInterval: BACKSTOP_REFRESH_MS,
  });

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey });
      }, EVENT_DEBOUNCE_MS);
    };
    const unsubscribeAgents = paseo.agents.subscribe(invalidate);
    const unsubscribeWorkspaces = paseo.workspaces.subscribe(invalidate);
    return () => {
      clearTimeout(timer);
      unsubscribeAgents();
      unsubscribeWorkspaces();
    };
  }, [paseo, queryClient, queryKey]);

  const rawRows = data?.rows ?? [];
  const scopeUrls = useMemo(() => rawRows.map((row) => row.url), [rawRows]);
  const {
    data: viewerData,
    error: viewerQueryError,
    isFetching: isViewerFetching,
    refetch: refetchViewer,
  } = useQuery({
    queryKey: ["pr-radar-viewer-scope", host.id, scopeUrls, windowDays],
    queryFn: () => resolveViewerScope({ urls: scopeUrls, windowDays }),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const mergedRows = useMemo(
    () => (data ? mergeInboxRows(data, viewerData?.inboxItems ?? []) : []),
    [data, viewerData],
  );
  const rows = useMemo(
    () => applyViewerScope(mergedRows, viewerData ?? null),
    [mergedRows, viewerData],
  );
  const isFetching = isDirectoryFetching || isViewerFetching;
  const viewerError =
    viewerData?.error ??
    (viewerQueryError instanceof Error
      ? viewerQueryError.message
      : viewerQueryError
        ? "error"
        : null);
  const acknowledgeMutation = useMutation({
    mutationFn: () => acknowledgeUpdates({ windowDays }),
    onSuccess: async () => {
      setActionNotice("PR Radar updates marked as seen.");
      await refetchViewer();
    },
    onError: (mutationError) => {
      setOpenError(
        mutationError instanceof Error ? mutationError.message : "Could not clear radar updates.",
      );
    },
  });
  const agentMutation = useMutation({
    mutationFn: async (row: RadarRow) => {
      const action = agentActionFor(row);
      if (!action) throw new Error("No agent action is available for this pull request.");
      const prompt = buildAgentPrompt(row);
      if (action.kind === "ask") {
        await paseo.agents.ref(action.agentId).send(prompt);
        return `Asked an agent to handle ${row.repository}#${row.number ?? "PR"}.`;
      }

      const { config } = await paseo.config.get();
      const profiles = config.agentProfiles ?? [];
      const profile =
        profiles.find((candidate) => candidate.name.toLowerCase() === "model router") ??
        profiles[0];
      if (!profile) {
        throw new Error("Configure an agent profile in Paseo before starting an agent.");
      }
      const provider = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
      const agentOptions = {
        config: {
          provider,
          ...(profile.modeId ? { modeId: profile.modeId } : {}),
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
          ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
        },
        title: `PR Radar: ${row.repository}#${row.number ?? "PR"}`,
        prompt,
      };
      const targetWorkspace =
        action.kind === "checkout"
          ? await paseo.workspaces.create({
              title: `${row.reviewRequestedFromMe ? "Review" : "Work on"} ${row.repository}#${action.number}`,
              source: {
                kind: "worktree",
                cwd: action.cwd,
                action: "checkout",
                checkoutSource: {
                  kind: "change_request",
                  forge: "github",
                  number: action.number,
                  projectPath: action.repository,
                },
              },
            })
          : paseo.workspaces.ref(action.workspaceId);
      const created = await targetWorkspace.agents.create(agentOptions);
      navigation?.openAgent({ agentId: created.id });
      return `Started ${profile.name} for ${row.repository}#${row.number ?? "PR"}.`;
    },
    onMutate: () => {
      setOpenError(null);
      setActionNotice(null);
    },
    onSuccess: (message) => {
      setActionNotice(message);
    },
    onError: (mutationError) => {
      setOpenError(
        mutationError instanceof Error ? mutationError.message : "Could not contact an agent.",
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const counts = useMemo(() => {
    const result: Record<RadarBucket, number> = {
      "needs-you": 0,
      ready: 0,
      "being-handled": 0,
      waiting: 0,
    };
    for (const row of rows) result[row.bucket] += 1;
    return result;
  }, [rows]);
  const activeCount = useMemo(
    () => rows.filter((row) => hasActiveAgent(row.agents)).length,
    [rows],
  );
  const savedViewCounts = useMemo<Record<SavedView, number>>(
    () => ({
      security: rows.filter(({ isSecurity }) => isSecurity).length,
      updated: rows.filter(({ changes }) => changes.length > 0).length,
      stale: rows.filter(
        ({ activityAt }) => activityAt && now - Date.parse(activityAt) >= STALE_AFTER_MS,
      ).length,
      automation: rows.filter(({ authorKind }) => authorKind === "bot").length,
    }),
    [now, rows],
  );
  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        const matchesSavedView =
          !savedView ||
          (savedView === "security" && row.isSecurity) ||
          (savedView === "updated" && row.changes.length > 0) ||
          (savedView === "stale" &&
            Boolean(row.activityAt && now - Date.parse(row.activityAt) >= STALE_AFTER_MS)) ||
          (savedView === "automation" && row.authorKind === "bot");
        return (
          (!selected || row.bucket === selected) &&
          (!activeOnly || hasActiveAgent(row.agents)) &&
          matchesSavedView &&
          matchesRow(row, search)
        );
      }),
    [activeOnly, now, rows, savedView, search, selected],
  );

  const styles = useMemo(() => {
    const gutter = layout.compact ? 14 : 24;
    const mutedBorder = `${theme.colors.foregroundMuted}35`;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        width: "100%" as const,
        maxWidth: 1180,
        alignSelf: "center" as const,
        paddingBottom: 48,
      },
      header: {
        paddingHorizontal: gutter,
        paddingTop: layout.compact ? 18 : 28,
        paddingBottom: 18,
        gap: 14,
      },
      signalLine: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      signalLabel: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      signalDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: theme.colors.statusSuccess,
      },
      eyebrow: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "700" as const,
        letterSpacing: 1.8,
      },
      heroTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 28 : 38,
        lineHeight: layout.compact ? 32 : 42,
        fontWeight: "800" as const,
        letterSpacing: -1.2,
      },
      heroDetail: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      summary: {
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        gap: 1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.border,
        borderRadius: 12,
        overflow: "hidden" as const,
      },
      metric: {
        flex: 1,
        paddingHorizontal: layout.compact ? 13 : 16,
        paddingVertical: layout.compact ? 10 : 14,
        backgroundColor: theme.colors.surface1,
        flexDirection: layout.compact ? ("row" as const) : ("column" as const),
        alignItems: layout.compact ? ("center" as const) : ("flex-start" as const),
        justifyContent: "space-between" as const,
        gap: 3,
      },
      metricValue: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 22 : 30,
        fontWeight: "800" as const,
      },
      metricLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "700" as const,
        letterSpacing: 0.7,
        textTransform: "uppercase" as const,
      },
      refresh: {
        minHeight: 36,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      refreshPressed: { opacity: 0.72 },
      refreshText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "700" as const,
      },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 7 },
      chip: {
        minHeight: 32,
        justifyContent: "center" as const,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: mutedBorder,
        borderRadius: 16,
      },
      chipActive: {
        backgroundColor: theme.colors.foreground,
        borderColor: theme.colors.foreground,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      chipTextActive: { color: theme.colors.surface0 },
      search: {
        minHeight: 40,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 14,
      },
      warning: {
        marginHorizontal: gutter,
        marginBottom: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.statusWarning,
        backgroundColor: theme.colors.surface1,
      },
      warningText: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      row: {
        flexDirection: "row" as const,
        marginHorizontal: gutter,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        minHeight: layout.compact ? 152 : 122,
      },
      rail: { width: 3, marginVertical: 14, borderRadius: 2 },
      rowBody: {
        flex: 1,
        paddingVertical: 14,
        paddingLeft: 12,
        gap: 6,
      },
      rowTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      identifier: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "700" as const,
        letterSpacing: 0.4,
        textTransform: "uppercase" as const,
      },
      badge: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "700" as const,
        borderWidth: 1,
        borderColor: mutedBorder,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 15 : 16,
        fontWeight: "700" as const,
        lineHeight: 21,
      },
      reasonLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
      reasonDot: { width: 7, height: 7, borderRadius: 4 },
      reason: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      metadata: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      actions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingLeft: layout.compact ? 0 : 12,
        paddingTop: layout.compact ? 4 : 0,
      },
      action: {
        minHeight: 34,
        justifyContent: "center" as const,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
      },
      actionPrimary: { borderColor: theme.colors.accent },
      actionAgent: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      actionAgentText: { color: theme.colors.accentForeground },
      actionDisabled: { opacity: 0.55 },
      actionText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      actionPrimaryText: { color: theme.colors.accent },
      empty: {
        paddingHorizontal: gutter,
        paddingVertical: 52,
        alignItems: "center" as const,
        gap: 8,
      },
      emptyTitle: { color: theme.colors.foreground, fontSize: 18, fontWeight: "700" as const },
      emptyDetail: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        lineHeight: 19,
        textAlign: "center" as const,
        maxWidth: 420,
      },
      error: { color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 },
      notice: { color: theme.colors.statusSuccess, fontSize: 13, lineHeight: 18 },
      spinner: { marginVertical: 52 },
    };
  }, [layout.compact, theme]);

  const openPr = useCallback(async (row: RadarRow) => {
    setOpenError(null);
    try {
      await Linking.openURL(row.url);
    } catch {
      setOpenError(`Could not open ${row.repository}#${row.number ?? "PR"}.`);
    }
  }, []);

  const renderRow = ({ item }: { item: RadarRow }) => {
    const color = bucketColor(item.bucket, theme.colors);
    const age = formatAge(item.activityAt, now);
    const isStale = Boolean(item.activityAt && now - Date.parse(item.activityAt) >= STALE_AFTER_MS);
    const branchSummary =
      item.headRefName && item.baseRefName ? ` · ${item.headRefName} → ${item.baseRefName}` : "";
    const primaryAgent = item.agents[0];
    const agentAction = agentActionFor(item);
    const actionPending = agentMutation.isPending && agentMutation.variables?.id === item.id;
    const ownershipLabel = item.reviewRequestedFromMe
      ? "REVIEW"
      : item.ownership === "mine"
        ? "YOURS"
        : item.ownership === "external"
          ? "EXTERNAL"
          : "SCOPE UNKNOWN";
    const actions = (
      <View style={styles.actions}>
        {agentAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${agentAction.kind === "ask" ? "Ask an agent to handle" : "Start an agent for"} ${item.repository} ${item.number ?? ""}`}
            accessibilityState={{ busy: actionPending, disabled: agentMutation.isPending }}
            disabled={agentMutation.isPending}
            onPress={() => agentMutation.mutate(item)}
            style={({ pressed }) => [
              styles.action,
              styles.actionAgent,
              (pressed || actionPending) && styles.refreshPressed,
              agentMutation.isPending && styles.actionDisabled,
            ]}
          >
            <Text style={[styles.actionText, styles.actionAgentText]}>
              {actionPending
                ? agentAction.kind === "ask"
                  ? "Sending…"
                  : "Starting…"
                : agentAction.kind === "ask"
                  ? "Ask agent"
                  : "Start agent"}
            </Text>
          </Pressable>
        ) : null}
        {navigation && primaryAgent ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open agent ${primaryAgent.title}`}
            onPress={() => navigation.openAgent({ agentId: primaryAgent.id })}
            style={({ pressed }) => [styles.action, pressed && styles.refreshPressed]}
          >
            <Text style={styles.actionText}>Open agent</Text>
          </Pressable>
        ) : null}
        {navigation && !primaryAgent && item.workspaceIds[0] ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open workspace for ${item.repository} ${item.number ?? ""}`}
            onPress={() => navigation.openWorkspace({ workspaceId: item.workspaceIds[0] })}
            style={({ pressed }) => [styles.action, pressed && styles.refreshPressed]}
          >
            <Text style={styles.actionText}>Open workspace</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open pull request ${item.repository} ${item.number ?? ""}`}
          onPress={() => void openPr(item)}
          style={({ pressed }) => [
            styles.action,
            styles.actionPrimary,
            pressed && styles.refreshPressed,
          ]}
        >
          <Text style={[styles.actionText, styles.actionPrimaryText]}>Open PR</Text>
        </Pressable>
      </View>
    );

    return (
      <View style={styles.row}>
        <View style={[styles.rail, { backgroundColor: color }]} />
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.identifier} numberOfLines={1}>
              {item.repository}
              {item.number ? ` #${item.number}` : ""}
            </Text>
            <Text style={styles.badge}>{ownershipLabel}</Text>
            {item.isDraft ? <Text style={styles.badge}>DRAFT</Text> : null}
            {item.authorKind === "bot" ? <Text style={styles.badge}>BOT</Text> : null}
            {item.isSecurity ? <Text style={styles.badge}>SECURITY</Text> : null}
            {isStale ? <Text style={styles.badge}>STALE</Text> : null}
          </View>
          <Text style={styles.title} numberOfLines={2} ellipsizeMode="tail">
            {item.title}
          </Text>
          <View style={styles.reasonLine}>
            <View style={[styles.reasonDot, { backgroundColor: color }]} />
            <Text style={styles.reason}>{item.reason}</Text>
          </View>
          <Text style={styles.metadata} numberOfLines={1} ellipsizeMode="middle">
            {checkSummary(item)}
            {branchSummary}
          </Text>
          <Text style={styles.metadata} numberOfLines={1} ellipsizeMode="tail">
            {item.author ? `${item.author} · ` : ""}
            {agentState(item)}
            {age ? ` · activity ${age} ago` : ""}
            {item.comments > 0 ? ` · ${item.comments} comments` : ""}
          </Text>
          {item.changes.length > 0 ? (
            <Text style={styles.notice} numberOfLines={2}>
              Updated · {item.changes.join(" · ")}
            </Text>
          ) : null}
          {layout.compact ? actions : null}
        </View>
        {layout.compact ? null : actions}
      </View>
    );
  };

  const totalCopy = `${rows.length} open ${rows.length === 1 ? "pull request" : "pull requests"}; ${rawRows.length} linked to ${data?.workspaceCount ?? 0} workspaces`;
  const emptyCopy = search
    ? "No pull requests match this search."
    : activeOnly
      ? "No pull requests have a running or initializing agent."
      : savedView
        ? `No pull requests match the ${SAVED_VIEW_TITLES[savedView].toLowerCase()} view.`
        : selected
          ? `No pull requests are ${BUCKET_TITLES[selected].toLowerCase()}.`
          : "No open pull requests are visible to GitHub or linked to a Paseo workspace.";
  const summaryMetrics = [
    { label: "Action now", value: counts["needs-you"] },
    { label: "Ready", value: counts.ready },
    { label: "Handled", value: counts["being-handled"] },
    { label: "Waiting", value: counts.waiting },
    { label: "Updates", value: viewerData?.updates ?? 0 },
    { label: "Agent PRs", value: activeCount },
  ];

  const header = (
    <View style={styles.header}>
      <View style={styles.signalLine}>
        <View style={styles.signalLabel}>
          <View style={styles.signalDot} />
          <Text style={styles.eyebrow}>PR RADAR · {viewerData?.viewer ?? "GITHUB"}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh pull request status"
          accessibilityState={{ busy: isFetching }}
          disabled={isFetching}
          onPress={() => void Promise.all([refetch(), refetchViewer()])}
          style={({ pressed }) => [styles.refresh, pressed && styles.refreshPressed]}
        >
          <Text style={styles.refreshText}>{isFetching ? "Scanning" : "Refresh"}</Text>
        </Pressable>
      </View>
      <Text style={styles.heroTitle}>Know what moves next.</Text>
      <Text style={styles.heroDetail}>{totalCopy}</Text>
      <View accessibilityRole="summary" style={styles.summary}>
        {summaryMetrics.map(({ label, value }) => (
          <View key={label} style={styles.metric}>
            <Text style={styles.metricValue}>{value}</Text>
            <Text style={styles.metricLabel}>{label}</Text>
          </View>
        ))}
      </View>
      <View accessibilityRole="tablist" style={styles.chips}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: selected === null && !activeOnly && !savedView }}
          onPress={() => {
            setSelected(null);
            setActiveOnly(false);
            setSavedView(null);
          }}
          style={[styles.chip, selected === null && !activeOnly && !savedView && styles.chipActive]}
        >
          <Text
            style={[
              styles.chipText,
              selected === null && !activeOnly && !savedView && styles.chipTextActive,
            ]}
          >
            All {rows.length}
          </Text>
        </Pressable>
        {BUCKETS.map((bucket) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: selected === bucket }}
            key={bucket}
            onPress={() => {
              setSelected(bucket);
              setActiveOnly(false);
              setSavedView(null);
            }}
            style={[styles.chip, selected === bucket && styles.chipActive]}
          >
            <Text style={[styles.chipText, selected === bucket && styles.chipTextActive]}>
              {BUCKET_TITLES[bucket]} {counts[bucket]}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeOnly }}
          onPress={() => {
            setSelected(null);
            setActiveOnly(true);
            setSavedView(null);
          }}
          style={[styles.chip, activeOnly && styles.chipActive]}
        >
          <Text style={[styles.chipText, activeOnly && styles.chipTextActive]}>
            Active agents {activeCount}
          </Text>
        </Pressable>
        {(Object.keys(SAVED_VIEW_TITLES) as SavedView[]).map((view) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: savedView === view }}
            key={view}
            onPress={() => {
              setSelected(null);
              setActiveOnly(false);
              setSavedView(view);
            }}
            style={[styles.chip, savedView === view && styles.chipActive]}
          >
            <Text style={[styles.chipText, savedView === view && styles.chipTextActive]}>
              {SAVED_VIEW_TITLES[view]} {savedViewCounts[view]}
            </Text>
          </Pressable>
        ))}
        {([7, 30, 90] as const).map((days) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: windowDays === days }}
            key={days}
            onPress={() => setWindowDays(days)}
            style={[styles.chip, windowDays === days && styles.chipActive]}
          >
            <Text style={[styles.chipText, windowDays === days && styles.chipTextActive]}>
              {days}d
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="Filter pull requests"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setSearch}
        placeholder="Filter by PR, branch, workspace, or agent"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.search}
        value={search}
      />
      {viewerData ? (
        <View style={{ gap: 7 }}>
          <Text style={styles.heroDetail}>
            {viewerData.coverageNote}
            {viewerData.truncated ? " Results reached the 100-item inbox cap." : ""}
          </Text>
          {viewerData.updates > 0 ? (
            <Text style={styles.heroDetail}>
              These are PR state changes detected in the {windowDays}-day view. Marking them seen
              only clears PR Radar badges; it does not change GitHub notifications or pull requests.
            </Text>
          ) : null}
          {viewerData.updates > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mark ${viewerData.updates} detected pull request updates as seen`}
              accessibilityState={{ busy: acknowledgeMutation.isPending }}
              disabled={acknowledgeMutation.isPending}
              onPress={() => acknowledgeMutation.mutate()}
              style={({ pressed }) => [styles.refresh, pressed && styles.refreshPressed]}
            >
              <Text style={styles.refreshText}>
                {acknowledgeMutation.isPending
                  ? "Marking…"
                  : `Mark ${viewerData.updates} updates seen`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {actionNotice ? <Text style={styles.notice}>{actionNotice}</Text> : null}
      {openError ? <Text style={styles.error}>{openError}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error instanceof Error ? error.message : "Could not load the delivery queue."}
        </Text>
      ) : null}
      {viewerError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          GitHub viewer identity is unavailable. Action buckets are conservative.
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        contentContainerStyle={styles.content}
        data={visibleRows}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        ListEmptyComponent={
          isPending ? (
            <ActivityIndicator color={theme.colors.accent} style={styles.spinner} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {rows.length === 0 ? "Clear runway" : "Nothing here"}
              </Text>
              <Text style={styles.emptyDetail}>{emptyCopy}</Text>
            </View>
          )
        }
        renderItem={renderRow}
      />
      {data?.warnings.length ? (
        <View style={styles.warning}>
          <Text style={styles.warningText} numberOfLines={2}>
            {data.warnings.length}{" "}
            {data.warnings.length === 1 ? "workspace has" : "workspaces have"} unavailable pull
            request status. Other results are current.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
