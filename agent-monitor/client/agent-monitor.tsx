import { getPaseoClient, type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  Text,
  TextInput,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { initialBucket, type MonitorSettings, monitorSettings } from "../shared/monitor-settings";
import { DiffStat, type DiffStatStyles } from "./diff-stat";
import {
  peekAgentFocus,
  peekAgentOpen,
  requestAgentFocus,
  resolveDeepFocus,
  takeAgentFocus,
  takeAgentOpen,
} from "./focus-request";
import { useAllHostsInteractionGraph } from "./graph-data";
import { AgentGraph } from "./graph-view";
import { GROUPING_CHOICES, layoutForKey, SORT_CHOICES } from "./layout-keys";
import {
  type AgentEntry,
  age,
  BUCKET_TITLES,
  BUCKETS,
  type Bucket,
  bucketOf,
  buildRoster,
  childCounts,
  delegatedFromServerId,
  groupByProject,
  type HostScope,
  hostColor,
  hostOf,
  matches,
  mergeProjectGroupsAcrossHosts,
  type NamedGroup,
  type ProjectGroup,
  parentAgentId,
  parseBucketParam,
  placement,
  shouldCollapseWorkspace,
  stateLabel,
  title,
  type WorkspaceGroup,
  type WorkspaceSummary,
  waitingSince,
} from "./monitor";
import { useAllHostsMonitor } from "./monitor-data";
import { AgentOverview } from "./overview-screen";
import { settingsAreReady } from "./settings-state";
import { useKeyDown, type WebKeyEvent } from "./web-keys";

const CLOCK_INTERVAL_MS = 15_000;

type AgentMonitorProps = PluginSurfaceProps & {
  onOpenSettings(): void;
  /**
   * The screen's `bucket` param, which seeds the filter when the screen opens. Chips filter in
   * place: the host's `openScreen` pushes a new screen per call, which would stack a roster per
   * press and drop the search text. Omitted on hosts without screens.
   */
  bucketParam?: string;
  /**
   * An agent id to focus when the screen opens (e.g. from a saved link). The
   * monitor switches to the graph with that card selected, once.
   */
  agentParam?: string;
  /**
   * A nonce the sidebar sends when it opens this screen for a handoff. The
   * request itself travels in module state; the nonce only ties this screen
   * open to it, and re-runs the handoff when the screen is already mounted.
   */
  openAgentToken?: string;
  /**
   * A view to show when the screen opens ("overview" for the keyboard-driven
   * mission control, anything else for the roster). View switches afterwards
   * are local state.
   */
  viewParam?: string;
};

export function AgentMonitor(props: AgentMonitorProps) {
  const settingsState = useSettings(monitorSettings);
  // Hand off to the agent's own screen when the sidebar quick access asked for
  // it. The handoff runs in a layout effect so it lands before the monitor
  // paints, but the monitor still renders: if the navigation loses a race the
  // user sees the roster, never a blank screen. Hosts without navigation fall
  // back to the graph focus deep link.
  useLayoutEffect(() => {
    // The token arrives as a screen param and ties this open to the request; a
    // stale request never matches a later visit's token (or its absence).
    const pending = peekAgentOpen();
    if (!pending || pending.token !== props.openAgentToken) return;
    // Defer past this commit: a navigate dispatched while the pushed monitor
    // route is still being committed is dropped by the router. Take inside the
    // timer so an effect re-run before the tick cannot drop the request.
    const handoff = setTimeout(() => {
      // Check before taking: a newer monitor open may have replaced the request.
      const request = peekAgentOpen();
      if (!request || request.token !== props.openAgentToken) return;
      takeAgentOpen();
      if (props.navigation) {
        try {
          props.navigation.openAgent({ agentId: request.agentId, serverId: request.serverId });
          return;
        } catch {
          // ignore: the focus fallback runs below
        }
      }
      requestAgentFocus(request.agentId);
    }, 0);
    return () => clearTimeout(handoff);
  }, [props.navigation, props.openAgentToken]);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 12,
        padding: props.layout.compact ? 16 : 24,
        backgroundColor: props.theme.colors.surface0,
      },
      title: { color: props.theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      detail: { color: props.theme.colors.foregroundMuted, textAlign: "center" as const },
      error: { color: props.theme.colors.statusDanger, textAlign: "center" as const },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      action: {
        minHeight: 36,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderRadius: 8,
        borderColor: props.theme.colors.border,
      },
      actionText: { color: props.theme.colors.foreground },
    }),
    [props.layout.compact, props.theme],
  );

  // Layout clicks may arrive faster than a settings save resolves. Queue the
  // patch and save it once the previous write lands, so the second choice is
  // not rejected against a stale revision and silently dropped.
  const [pendingLayout, setPendingLayout] = useState<Partial<
    Pick<MonitorSettings, "grouping" | "agentSort">
  > | null>(null);
  useEffect(() => {
    if (!pendingLayout || !settingsAreReady(settingsState) || settingsState.saving) return;
    const state = settingsState;
    const patch = pendingLayout;
    setPendingLayout(null);
    void state.save({ ...state.values, ...patch }, state.revision);
  }, [pendingLayout, settingsState]);

  if (settingsAreReady(settingsState)) {
    const state = settingsState;
    return (
      <AgentMonitorRoster
        {...props}
        settings={state.values}
        saveError={state.saveError}
        onChangeLayout={(patch) => setPendingLayout((current) => ({ ...current, ...patch }))}
      />
    );
  }

  if (settingsState.status === "loading") {
    return (
      <View style={styles.screen}>
        <Text style={styles.detail}>Loading monitor settings…</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>
        {settingsState.status === "invalid"
          ? "Monitor settings are invalid"
          : "Settings unavailable"}
      </Text>
      <Text accessibilityRole="alert" style={styles.error}>
        {settingsState.error}
      </Text>
      {settingsState.saveError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {settingsState.saveError}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reload monitor settings"
          disabled={settingsState.saving}
          onPress={settingsState.reload}
          style={styles.action}
        >
          <Text style={styles.actionText}>Reload</Text>
        </Pressable>
        {settingsState.status === "invalid" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset invalid monitor settings"
            disabled={settingsState.saving}
            onPress={async () => {
              await settingsState.reset();
            }}
            style={styles.action}
          >
            <Text style={styles.actionText}>Reset to defaults</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open monitor settings"
          onPress={props.onOpenSettings}
          style={styles.action}
        >
          <Text style={styles.actionText}>Open settings</Text>
        </Pressable>
      </View>
    </View>
  );
}

const BUCKET_KEYS: Record<Bucket, string> = {
  attention: "T",
  running: "U",
  idle: "I",
  closed: "C",
};

function KeyBadge({ digit, badge, label }: { digit: string; badge: ViewStyle; label: TextStyle }) {
  return (
    <View style={badge}>
      <Text style={label}>{digit}</Text>
    </View>
  );
}

function AgentMonitorRoster({
  theme,
  layout,
  navigation,
  onOpenSettings,
  bucketParam,
  agentParam,
  viewParam,
  settings,
  saveError,
  onChangeLayout,
}: AgentMonitorProps & {
  settings: MonitorSettings;
  saveError?: string | null;
  onChangeLayout(patch: Partial<Pick<MonitorSettings, "grouping" | "agentSort">>): void;
}) {
  const monitor = useAllHostsMonitor();
  const { entries: allEntries, directory, hosts, truncated, failedHosts } = monitor;

  const [selected, setSelected] = useState<Bucket | null>(() => {
    const fromParam = parseBucketParam(bucketParam);
    return fromParam === undefined ? initialBucket(settings) : fromParam;
  });
  const [hostSelected, setHostSelected] = useState<string | null>(null);
  const [needle, setNeedle] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [sweepArmed, setSweepArmed] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [view, setView] = useState<"roster" | "graph" | "overview">(() =>
    viewParam === "overview" ? "overview" : "roster",
  );
  useKeyDown(
    useCallback(
      (event: WebKeyEvent) => {
        // Letters drive the header everywhere (the overview owns digits for
        // jumping to agents). R/G/O switch views; A/T/U/I/C pick filters.
        switch (event.key.toLowerCase()) {
          case "r":
            setView("roster");
            break;
          case "g":
            setView("graph");
            break;
          case "o":
            setView("overview");
            break;
          case "a":
            setSelected(null);
            break;
          case "t":
            setSelected(selected === "attention" ? null : "attention");
            break;
          case "u":
            setSelected(selected === "running" ? null : "running");
            break;
          case "i":
            setSelected(selected === "idle" ? null : "idle");
            break;
          case "c":
            setSelected(selected === "closed" ? null : "closed");
            break;
          default: {
            // P/W/H/Y/N group; S/E/Z sort. Separate axes, so a host group still
            // orders its rows by recency or title.
            const layout = layoutForKey(event.key);
            if (layout) onChangeLayout(layout);
            break;
          }
        }
      },
      [onChangeLayout, selected],
    ),
  );

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(clock);
  }, []);

  const entriesById = useMemo(
    () => new Map(allEntries.map((entry) => [entry.agent.id, entry])),
    [allEntries],
  );

  const archive = useMutation({
    mutationFn: async (agentIds: readonly string[]) => {
      const byHost = new Map<string, string[]>();
      for (const agentId of agentIds) {
        const entry = entriesById.get(agentId);
        const serverId = entry ? hostOf(entry)?.serverId : undefined;
        if (!serverId) continue;
        const list = byHost.get(serverId);
        if (list) list.push(agentId);
        else byHost.set(serverId, [agentId]);
      }
      for (const [serverId, ids] of byHost) {
        const client = getPaseoClient(serverId);
        for (const id of ids) await client.agents.ref(id).archive();
      }
    },
    onSettled: () => monitor.refetchAll(),
  });

  const entries = useMemo(
    () =>
      hostSelected === null
        ? allEntries
        : allEntries.filter((entry) => hostOf(entry)?.serverId === hostSelected),
    [allEntries, hostSelected],
  );
  const multiHost = hosts.length > 1;

  // Deep link from the sidebar quick access: once the entries arrive, show
  // everything and focus the requested agent's card in the graph. The request
  // lives in module state as well as in params, because reopening the same
  // screen does not always deliver fresh params.
  const [deepFocusId, setDeepFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (deepFocusId) return;
    const wanted = resolveDeepFocus(
      peekAgentFocus(),
      agentParam,
      allEntries.map((entry) => entry.agent.id),
    );
    if (wanted) {
      takeAgentFocus();
      setDeepFocusId(wanted);
      setHostSelected(null);
      setSelected(null);
      setView("graph");
    }
  }, [agentParam, allEntries, deepFocusId]);
  const counts = useMemo(() => {
    const totals: Record<Bucket, number> = { attention: 0, running: 0, idle: 0, closed: 0 };
    for (const entry of entries) totals[bucketOf(entry.agent)] += 1;
    return totals;
  }, [entries]);
  const childrenByParent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const host of hosts) {
      const scoped = entries.filter(
        (entry) => (hostOf(entry)?.serverId ?? host.serverId) === host.serverId,
      );
      for (const [id, count] of childCounts(scoped, host.serverId)) {
        counts.set(id, (counts.get(id) ?? 0) + count);
      }
    }
    return counts;
  }, [entries, hosts]);
  const closedIds = useMemo(
    () =>
      entries.filter((entry) => bucketOf(entry.agent) === "closed").map((entry) => entry.agent.id),
    [entries],
  );
  const visibleEntries = useMemo(() => {
    const search = needle.trim().toLowerCase();
    return entries.filter((entry) => {
      const bucket = bucketOf(entry.agent);
      if (selected !== null) {
        if (bucket !== selected) return false;
      } else if (settings.hideClosedUnlessFiltered && bucket === "closed") {
        return false;
      }
      return matches(entry, search);
    });
  }, [entries, needle, selected, settings]);
  const roster = useMemo(() => {
    // Compact and workspace rosters sort across every host at once: entries
    // resolve parent links against their own host. Project groups build per
    // host (project ids are daemon scoped) and merge by name afterwards.
    if (settings.grouping !== "project") {
      return buildRoster(visibleEntries, directory, settings, hosts[0]?.serverId ?? "");
    }
    const scopedEntries = (host: HostScope) =>
      visibleEntries.filter(
        (entry) => (hostOf(entry)?.serverId ?? host.serverId) === host.serverId,
      );
    const perHost = hosts.map((host: HostScope) => ({
      host,
      projects: groupByProject(scopedEntries(host), directory, {
        floatPinned: settings.floatPinned,
        agentSort: settings.agentSort,
        hostId: host.serverId,
      }),
    }));
    return {
      kind: "project" as const,
      projects: mergeProjectGroupsAcrossHosts(perHost, settings),
    };
  }, [directory, hosts, settings, visibleEntries]);
  // Full roster, not visibleEntries: the graph reads timelines and must not rescan per keystroke.
  const interactions = useAllHostsInteractionGraph(hosts, entries, view === "graph");
  const refetchInteractions = interactions.refetch;
  const refresh = useCallback(() => {
    monitor.refetchAll();
    if (view === "graph" && entries.length > 0) void refetchInteractions();
  }, [entries.length, monitor.refetchAll, refetchInteractions, view]);

  const styles = useMemo(() => {
    const gutter = layout.compact ? 12 : 20;
    const rowPad = settings.density === "compact" ? 6 : 10;
    const muted = theme.colors.foregroundMuted;
    const border = theme.colors.border;
    const rowAlign = {
      flexDirection: "row" as const,
      alignItems: "center" as const,
    };
    const chipBase = {
      minHeight: 28,
      paddingHorizontal: 8,
      borderRadius: 6,
      borderWidth: 1,
      justifyContent: "center" as const,
    };
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: { paddingHorizontal: gutter, paddingTop: gutter, gap: 10 },
      summaryLine: { ...rowAlign, gap: 8 },
      viewToggle: {
        flexDirection: "row" as const,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: border,
        overflow: "hidden" as const,
      },
      viewToggleItem: { paddingHorizontal: 8, paddingVertical: 4 },
      viewToggleItemOn: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        backgroundColor: theme.colors.accent,
      },
      viewToggleText: { color: muted, fontSize: 11 },
      viewToggleTextOn: { color: theme.colors.accentForeground, fontSize: 11 },
      summary: { flex: 1, color: muted, fontSize: 13 },
      syncing: { color: muted, fontSize: 11, opacity: 0.8 },
      syncingHidden: { opacity: 0 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      chip: { ...chipBase, borderColor: border },
      chipOn: {
        ...chipBase,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      chipText: { color: muted, fontSize: 12 },
      chipTextOn: { color: theme.colors.accentForeground, fontSize: 12 },
      chipRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      keyBadge: {
        minWidth: 18,
        alignItems: "center" as const,
        borderRadius: 5,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 4,
        paddingVertical: 1,
      },
      keyBadgeText: { color: muted, fontSize: 10 },
      search: {
        color: theme.colors.foreground,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: border,
        fontSize: 13,
      },
      actions: { ...rowAlign, gap: 8 },
      action: {
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: border,
      },
      refreshAction: {
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: border,
      },
      gearButton: {
        width: 26,
        height: 26,
        borderRadius: 13,
        borderWidth: 1,
        borderColor: border,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      dangerText: { color: theme.colors.statusDanger, fontSize: 12 },
      row: {
        paddingHorizontal: gutter,
        paddingVertical: rowPad,
        flexDirection: "row" as const,
        gap: 10,
        alignItems: "flex-start" as const,
      },
      // Alpha composite: the SDK has no danger-tint token for a highlighted destructive target.
      rowSweepTarget: { backgroundColor: `${theme.colors.statusDanger}1A` },
      rowMain: {
        flex: 1,
        flexDirection: "row" as const,
        gap: 10,
        alignItems: "flex-start" as const,
      },
      navigationPressed: { opacity: 0.65 },
      dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
      rowBody: { flex: 1, gap: 3 },
      rowTitleLine: { ...rowAlign, gap: 6 },
      rowTitle: { flex: 1, color: theme.colors.foreground, fontSize: 14 },
      rowStatus: {
        color: muted,
        fontSize: 11,
        fontVariant: ["tabular-nums" as const],
        minWidth: 64,
        textAlign: "right" as const,
      },
      rowMeta: { color: muted, fontSize: 12 },
      childCount: { color: muted, fontSize: 11 },
      rowError: { color: theme.colors.statusDanger, fontSize: 12 },
      childRow: {
        paddingLeft: gutter,
        borderLeftWidth: 2,
        borderLeftColor: border,
      },
      projectHeaderRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface0,
      },
      projectWorkspaceAction: { marginRight: gutter },
      projectHeader: {
        flex: 1,
        minWidth: 0,
        paddingHorizontal: gutter,
        paddingTop: 14,
        paddingBottom: 6,
        gap: 2,
        backgroundColor: theme.colors.surface0,
      },
      projectHeaderPressed: { backgroundColor: theme.colors.surface1 },
      namedHeader: {
        minHeight: layout.compact ? 44 : 32,
        paddingHorizontal: gutter,
        paddingTop: 10,
        paddingBottom: 4,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        backgroundColor: theme.colors.surface0,
      },
      namedCount: { color: muted, fontSize: 11 },
      orderLabel: {
        color: muted,
        fontSize: 11,
        alignSelf: "center" as const,
        marginRight: 2,
      },
      workspaceHeader: {
        minHeight: layout.compact ? 44 : 32,
        paddingHorizontal: gutter,
        paddingTop: 8,
        paddingBottom: 4,
        gap: 2,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface0,
      },
      headerTitleLine: { ...rowAlign, gap: 8 },
      projectTitle: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "700" as const,
      },
      workspaceTitle: {
        flex: 1,
        color: muted,
        fontSize: 12,
        fontWeight: "600" as const,
      },
      headerMeta: { color: muted, fontSize: 11 },
      diffStat: { flexDirection: "row" as const, gap: 4 },
      diffAdd: { color: theme.colors.statusSuccess, fontSize: 11 },
      diffDel: { color: theme.colors.statusDanger, fontSize: 11 },
      diffMuted: { color: muted, fontSize: 11 },
      rowRight: { ...rowAlign, height: 20, gap: 10 },
      iconButton: {
        width: 32,
        height: 32,
        borderRadius: 6,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      iconButtonPressed: { opacity: 0.55 },
      separator: { height: 1, backgroundColor: border },
      listContent: { paddingTop: 6 },
      empty: { padding: gutter, color: muted },
      error: { paddingHorizontal: gutter, paddingTop: 10, color: theme.colors.statusDanger },
    } satisfies Record<string, object> & DiffStatStyles;
  }, [layout.compact, settings.density, theme]);

  const renderRow = useCallback(
    ({ item }: { item: AgentEntry }) => {
      const { agent } = item;
      const bucket = bucketOf(agent);
      const children = childrenByParent.get(agent.id) ?? 0;
      const state = stateLabel(agent);
      const status =
        bucket === "running" || !settings.showAge
          ? state
          : `${state} · ${age(waitingSince(agent), now)}`;
      const dotColor =
        agent.status === "error"
          ? theme.colors.statusDanger
          : bucket === "attention"
            ? theme.colors.statusWarning
            : bucket === "running"
              ? theme.colors.statusSuccess
              : theme.colors.foregroundMuted;
      const meta = agent.model ?? agent.provider;
      const delegatedFrom = delegatedFromServerId(agent, hostOf(item)?.serverId ?? "");
      const delegatedFromLabel = delegatedFrom
        ? (hosts.find((candidate) => candidate.serverId === delegatedFrom)?.label ?? delegatedFrom)
        : null;
      const showPlacement = settings.grouping === "compact" && settings.showPlacementInCompact;
      const body = (
        <>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <View style={styles.rowBody}>
            <View style={styles.rowTitleLine}>
              <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
                {title(item)}
              </Text>
              {settings.showSubagentCounts && children > 0 ? (
                <Text style={styles.childCount}>
                  {children} {children === 1 ? "subagent" : "subagents"}
                </Text>
              ) : null}
            </View>
            {showPlacement ? (
              <Text style={styles.rowMeta} numberOfLines={1} ellipsizeMode="tail">
                {multiHost && hostOf(item) ? `${hostOf(item)?.label} · ` : ""}
                {placement(item)}
              </Text>
            ) : null}
            {delegatedFromLabel ? (
              <Text style={styles.rowMeta} numberOfLines={1} ellipsizeMode="tail">
                Delegated from {delegatedFromLabel}
              </Text>
            ) : null}
            {settings.showModel && meta ? (
              <Text style={styles.rowMeta} numberOfLines={1} ellipsizeMode="tail">
                {meta}
              </Text>
            ) : null}
            {settings.showLastError && agent.lastError ? (
              <Text style={styles.rowError} numberOfLines={1}>
                {agent.lastError}
              </Text>
            ) : null}
          </View>
        </>
      );
      return (
        <View
          accessibilityState={{ selected: sweepArmed && bucket === "closed" }}
          style={[styles.row, sweepArmed && bucket === "closed" ? styles.rowSweepTarget : null]}
        >
          {navigation ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open agent ${title(item)}`}
              onPress={() =>
                navigation.openAgent({
                  agentId: agent.id,
                  ...(hostOf(item) ? { serverId: hostOf(item)?.serverId } : null),
                })
              }
              style={({ pressed }) => [styles.rowMain, pressed && styles.navigationPressed]}
            >
              {body}
            </Pressable>
          ) : (
            <View style={styles.rowMain}>{body}</View>
          )}
          <View style={styles.rowRight}>
            <Text style={styles.rowStatus}>{status}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Archive agent ${title(item)}`}
              hitSlop={4}
              onPress={() => archive.mutate([agent.id])}
              style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            >
              {({ pressed }) => (
                <Icon
                  name="Archive"
                  size={16}
                  color={pressed ? theme.colors.statusDanger : theme.colors.foregroundMuted}
                />
              )}
            </Pressable>
          </View>
        </View>
      );
    },
    [archive, childrenByParent, multiHost, navigation, now, settings, styles, sweepArmed, theme],
  );

  const renderWorkspaceHeader = useCallback(
    (workspace: WorkspaceSummary, host?: HostScope, showHost = false) => {
      const navigationId = workspace.navigationId;
      const content = (
        <>
          <View style={styles.headerTitleLine}>
            {settings.showPinDots && workspace.pinned ? (
              <View accessibilityLabel="Pinned workspace">
                <Icon name="Pin" size={12} color={theme.colors.accent} />
              </View>
            ) : null}
            <Text style={styles.workspaceTitle} numberOfLines={1} ellipsizeMode="tail">
              {workspace.name}
            </Text>
            {host && showHost ? (
              <View
                accessibilityLabel={`Host ${host.label}`}
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderColor: `${hostColor(host)}66`,
                  backgroundColor: `${hostColor(host)}26`,
                }}
              >
                <Text style={{ color: hostColor(host), fontSize: 9, fontWeight: "700" }}>
                  {host.label}
                </Text>
              </View>
            ) : null}
            {settings.showDiffStats ? (
              <DiffStat
                additions={workspace.additions}
                deletions={workspace.deletions}
                colorDiffStats={settings.colorDiffStats}
                styles={styles}
              />
            ) : null}
          </View>
          {workspace.labels.length > 0 ? (
            <Text style={styles.headerMeta} numberOfLines={1} ellipsizeMode="tail">
              {workspace.labels.slice(0, 2).join(" · ")}
            </Text>
          ) : null}
        </>
      );
      return navigation && navigationId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open workspace ${workspace.name}`}
          onPress={() =>
            navigation.openWorkspace({
              workspaceId: navigationId,
              ...(host ? { serverId: host.serverId } : null),
            })
          }
          style={({ pressed }) => [styles.workspaceHeader, pressed && styles.navigationPressed]}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.workspaceHeader}>{content}</View>
      );
    },
    [navigation, settings, styles, theme],
  );

  const renderWorkspaceGroup = useCallback(
    (group: WorkspaceGroup, project?: ProjectGroup) => {
      const collapse = project
        ? shouldCollapseWorkspace(project, group.workspace, settings.collapseMatchingWorkspace)
        : false;
      const scope = group.entries.length > 0 ? (hostOf(group.entries[0]) ?? undefined) : undefined;
      return (
        <View key={group.workspace.id}>
          {collapse ? null : renderWorkspaceHeader(group.workspace, scope, multiHost)}
          {group.entries.map((entry) => (
            <View
              key={entry.agent.id}
              style={
                parentAgentId(entry.agent, hostOf(entry)?.serverId ?? "") !== null
                  ? styles.childRow
                  : undefined
              }
            >
              {renderRow({ item: entry })}
            </View>
          ))}
        </View>
      );
    },
    [
      renderRow,
      renderWorkspaceHeader,
      multiHost,
      settings.collapseMatchingWorkspace,
      styles.childRow,
    ],
  );

  const renderProject = useCallback(
    ({ item: project }: { item: ProjectGroup }) => {
      const collapsed = collapsedProjects.has(project.id);
      const hostLabels = multiHost
        ? [
            ...new Set(
              project.workspaces.flatMap((group) =>
                group.entries.map((entry) => hostOf(entry)?.label),
              ),
            ),
          ]
            .filter((label): label is string => Boolean(label))
            .sort()
        : [];
      const collapsedGroup =
        project.workspaces.length === 1 &&
        shouldCollapseWorkspace(
          project,
          project.workspaces[0].workspace,
          settings.collapseMatchingWorkspace,
        )
          ? project.workspaces[0]
          : null;
      const collapsedWorkspace = collapsedGroup?.workspace ?? null;
      const collapsedWorkspaceId = collapsedWorkspace?.navigationId;
      const collapsedScope =
        collapsedGroup && collapsedGroup.entries.length > 0
          ? hostOf(collapsedGroup.entries[0])
          : undefined;
      return (
        <View>
          <View style={styles.projectHeaderRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${project.name} project`}
              accessibilityState={{ expanded: !collapsed }}
              onPress={() => {
                setCollapsedProjects((current) => {
                  const next = new Set(current);
                  if (next.has(project.id)) next.delete(project.id);
                  else next.add(project.id);
                  return next;
                });
              }}
              style={({ pressed }) => [
                styles.projectHeader,
                pressed && styles.projectHeaderPressed,
              ]}
            >
              <View style={styles.headerTitleLine}>
                <Icon
                  name={collapsed ? "ChevronRight" : "ChevronDown"}
                  size={14}
                  color={theme.colors.foregroundMuted}
                />
                {settings.showPinDots && (collapsedWorkspace?.pinned || project.pinned) ? (
                  <View accessibilityLabel="Pinned project">
                    <Icon name="Pin" size={12} color={theme.colors.accent} />
                  </View>
                ) : null}
                <Text style={styles.projectTitle} numberOfLines={1} ellipsizeMode="tail">
                  {project.name}
                </Text>
                {settings.showDiffStats && collapsedWorkspace ? (
                  <DiffStat
                    additions={collapsedWorkspace.additions}
                    deletions={collapsedWorkspace.deletions}
                    colorDiffStats={settings.colorDiffStats}
                    styles={styles}
                  />
                ) : null}
              </View>
              {collapsedWorkspace && collapsedWorkspace.labels.length > 0 ? (
                <Text style={styles.headerMeta} numberOfLines={1} ellipsizeMode="tail">
                  {collapsedWorkspace.labels.slice(0, 2).join(" · ")}
                </Text>
              ) : null}
              {hostLabels.length > 0 ? (
                <Text style={styles.headerMeta} numberOfLines={1} ellipsizeMode="tail">
                  {hostLabels.join(", ")}
                </Text>
              ) : null}
            </Pressable>
            {navigation && collapsedWorkspaceId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open workspace ${collapsedWorkspace?.name}`}
                hitSlop={6}
                onPress={() =>
                  navigation.openWorkspace({
                    workspaceId: collapsedWorkspaceId,
                    ...(collapsedScope ? { serverId: collapsedScope.serverId } : null),
                  })
                }
                style={({ pressed }) => [
                  styles.iconButton,
                  styles.projectWorkspaceAction,
                  pressed && styles.iconButtonPressed,
                ]}
              >
                <Icon name="FolderOpen" size={16} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
          </View>
          {collapsed
            ? null
            : project.workspaces.map((group) => renderWorkspaceGroup(group, project))}
        </View>
      );
    },
    [collapsedProjects, multiHost, navigation, renderWorkspaceGroup, settings, styles, theme],
  );

  const renderNamedGroup = useCallback(
    (group: NamedGroup) => {
      const collapsed = collapsedGroups.has(group.id);
      return (
        <View key={group.id}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${group.name} group`}
            accessibilityState={{ expanded: !collapsed }}
            onPress={() =>
              setCollapsedGroups((current) => {
                const next = new Set(current);
                if (next.has(group.id)) next.delete(group.id);
                else next.add(group.id);
                return next;
              })
            }
            style={({ pressed }) => [styles.namedHeader, pressed && styles.projectHeaderPressed]}
          >
            <Icon
              name={collapsed ? "ChevronRight" : "ChevronDown"}
              size={14}
              color={theme.colors.foregroundMuted}
            />
            <Text style={styles.projectTitle} numberOfLines={1} ellipsizeMode="tail">
              {group.name}
            </Text>
            <Text style={styles.namedCount}>{group.entries.length}</Text>
          </Pressable>
          {collapsed
            ? null
            : group.entries.map((entry) => (
                <View
                  key={entry.agent.id}
                  style={
                    parentAgentId(entry.agent, hostOf(entry)?.serverId ?? "") !== null
                      ? styles.childRow
                      : undefined
                  }
                >
                  {renderRow({ item: entry })}
                </View>
              ))}
        </View>
      );
    },
    [collapsedGroups, renderRow, styles, theme.colors.foregroundMuted],
  );

  const separator = useCallback(() => <View style={styles.separator} />, [styles]);
  const empty = (
    <Text style={styles.empty}>
      {monitor.isPending ? "Loading agents…" : "No agents match this filter."}
    </Text>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.summaryLine}>
          <Text style={styles.summary} numberOfLines={1} ellipsizeMode="tail">
            {entries.length} agents on{" "}
            {multiHost ? `${hosts.length} hosts` : (hosts[0]?.label ?? "this host")}
            {truncated ? "+" : ""}
          </Text>
          <Text style={[styles.syncing, monitor.isFetching ? null : styles.syncingHidden]}>
            syncing
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh agents"
            onPress={refresh}
            style={styles.refreshAction}
          >
            <Text style={styles.actionText}>Refresh</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open monitor settings"
            onPress={onOpenSettings}
            style={styles.gearButton}
          >
            <Icon name="Settings" size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <View style={styles.chips}>
          <View style={styles.viewToggle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show roster view (R)"
              onPress={() => setView("roster")}
              style={view === "roster" ? styles.viewToggleItemOn : styles.viewToggleItem}
            >
              <View style={styles.chipRow}>
                <KeyBadge digit="R" badge={styles.keyBadge} label={styles.keyBadgeText} />
                <Text style={view === "roster" ? styles.viewToggleTextOn : styles.viewToggleText}>
                  Roster
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show graph view (G)"
              onPress={() => setView("graph")}
              style={view === "graph" ? styles.viewToggleItemOn : styles.viewToggleItem}
            >
              <View style={styles.chipRow}>
                <KeyBadge digit="G" badge={styles.keyBadge} label={styles.keyBadgeText} />
                <Text style={view === "graph" ? styles.viewToggleTextOn : styles.viewToggleText}>
                  Graph
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show overview (O)"
              onPress={() => setView("overview")}
              style={view === "overview" ? styles.viewToggleItemOn : styles.viewToggleItem}
            >
              <View style={styles.chipRow}>
                <KeyBadge digit="O" badge={styles.keyBadge} label={styles.keyBadgeText} />
                <Text style={view === "overview" ? styles.viewToggleTextOn : styles.viewToggleText}>
                  Overview
                </Text>
              </View>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show all agents (A)"
            onPress={() => setSelected(null)}
            style={selected === null ? styles.chipOn : styles.chip}
          >
            <View style={styles.chipRow}>
              <KeyBadge digit="A" badge={styles.keyBadge} label={styles.keyBadgeText} />
              <Text style={selected === null ? styles.chipTextOn : styles.chipText}>
                All {entries.length}
              </Text>
            </View>
          </Pressable>
          {BUCKETS.map((bucket) => (
            <Pressable
              key={bucket}
              accessibilityRole="button"
              accessibilityLabel={`Show ${BUCKET_TITLES[bucket]} agents (${BUCKET_KEYS[bucket]})`}
              onPress={() => setSelected(selected === bucket ? null : bucket)}
              style={selected === bucket ? styles.chipOn : styles.chip}
            >
              <View style={styles.chipRow}>
                <KeyBadge
                  digit={BUCKET_KEYS[bucket]}
                  badge={styles.keyBadge}
                  label={styles.keyBadgeText}
                />
                <Text style={selected === bucket ? styles.chipTextOn : styles.chipText}>
                  {BUCKET_TITLES[bucket]} {counts[bucket]}
                </Text>
              </View>
            </Pressable>
          ))}
          {multiHost
            ? hosts.map((host: HostScope) => (
                <Pressable
                  key={host.serverId}
                  accessibilityRole="button"
                  accessibilityLabel={`Show agents on ${host.label}`}
                  onPress={() =>
                    setHostSelected(hostSelected === host.serverId ? null : host.serverId)
                  }
                  style={hostSelected === host.serverId ? styles.chipOn : styles.chip}
                >
                  <Text
                    style={hostSelected === host.serverId ? styles.chipTextOn : styles.chipText}
                  >
                    {host.label}
                  </Text>
                </Pressable>
              ))
            : null}
        </View>
        <View style={styles.chips}>
          <Text style={styles.orderLabel}>Group</Text>
          {GROUPING_CHOICES.map((choice) => {
            const active = settings.grouping === choice.id;
            return (
              <Pressable
                key={choice.id}
                accessibilityRole="button"
                accessibilityLabel={`Group by ${choice.label} (${choice.key})`}
                accessibilityState={{ selected: active }}
                onPress={() => onChangeLayout({ grouping: choice.id })}
                style={active ? styles.chipOn : styles.chip}
              >
                <View style={styles.chipRow}>
                  <KeyBadge
                    digit={choice.key}
                    badge={styles.keyBadge}
                    label={styles.keyBadgeText}
                  />
                  <Text style={active ? styles.chipTextOn : styles.chipText}>{choice.label}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.chips}>
          <Text style={styles.orderLabel}>Sort</Text>
          {SORT_CHOICES.map((choice) => {
            const active = settings.agentSort === choice.id;
            return (
              <Pressable
                key={choice.id}
                accessibilityRole="button"
                accessibilityLabel={`Sort by ${choice.label} (${choice.key}): ${choice.hint}`}
                accessibilityState={{ selected: active }}
                onPress={() => onChangeLayout({ agentSort: choice.id })}
                style={active ? styles.chipOn : styles.chip}
              >
                <View style={styles.chipRow}>
                  <KeyBadge
                    digit={choice.key}
                    badge={styles.keyBadge}
                    label={styles.keyBadgeText}
                  />
                  <Text style={active ? styles.chipTextOn : styles.chipText}>{choice.label}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          style={styles.search}
          value={needle}
          onChangeText={setNeedle}
          placeholder="Filter by title, project, path, model"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Filter agents"
        />
        {closedIds.length > 0 ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Archive ${closedIds.length} closed agents`}
              onPress={() => {
                if (!sweepArmed) {
                  setSweepArmed(true);
                  return;
                }
                setSweepArmed(false);
                archive.mutate(closedIds);
              }}
              style={styles.action}
            >
              <Text style={styles.dangerText}>
                {sweepArmed
                  ? `Confirm: archive ${closedIds.length} closed`
                  : `Archive ${closedIds.length} closed`}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {saveError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {saveError}
        </Text>
      ) : null}
      {failedHosts.length > 0 ? (
        <Text style={styles.error}>
          {failedHosts.join(", ")} unreachable, showing the remaining hosts
        </Text>
      ) : null}
      {archive.error ? <Text style={styles.error}>{archive.error.message}</Text> : null}
      {view === "overview" ? (
        <AgentOverview
          theme={theme}
          layout={layout}
          navigation={navigation}
          onExit={() => setView("roster")}
        />
      ) : view === "graph" ? (
        <AgentGraph
          entries={visibleEntries}
          hosts={hosts}
          focusedAgentId={
            deepFocusId && visibleEntries.some((entry) => entry.agent.id === deepFocusId)
              ? deepFocusId
              : null
          }
          interactions={interactions.data}
          loading={interactions.isPending}
          theme={theme}
          navigation={navigation}
          compact={layout.compact}
        />
      ) : roster.kind === "compact" ? (
        <FlatList
          data={roster.entries}
          keyExtractor={(entry) => entry.agent.id}
          contentContainerStyle={styles.listContent}
          renderItem={renderRow}
          ItemSeparatorComponent={separator}
          ListEmptyComponent={empty}
        />
      ) : roster.kind === "host" || roster.kind === "provider" ? (
        <FlatList
          data={roster.groups}
          keyExtractor={(group) => group.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => renderNamedGroup(item)}
          ItemSeparatorComponent={separator}
          ListEmptyComponent={empty}
        />
      ) : roster.kind === "workspace" ? (
        <FlatList
          data={roster.groups}
          keyExtractor={(group) => group.workspace.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => renderWorkspaceGroup(item)}
          ItemSeparatorComponent={separator}
          ListEmptyComponent={empty}
        />
      ) : (
        <FlatList
          data={roster.projects}
          keyExtractor={(project) => project.id}
          contentContainerStyle={styles.listContent}
          renderItem={renderProject}
          ItemSeparatorComponent={separator}
          ListEmptyComponent={empty}
        />
      )}
    </View>
  );
}
