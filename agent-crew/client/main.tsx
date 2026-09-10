import { type PluginWorkspacePanelProps, usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import {
  FlatList,
  Icon,
  Modal,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type ListRenderItemInfo, Pressable, StyleSheet, Text, View } from "react-native";
import {
  type AgentEntry,
  agentAgeTimestamp,
  agentTitle,
  buildCrewForest,
  CREW_STATE_LABELS,
  CREW_STATES,
  type CrewNode,
  type CrewState,
  collapseCrewNodes,
  crewCounts,
  crewState,
  formatAge,
  isWorking,
  type PaseoApi,
  type PaseoWorkspace,
  parentAgentId,
} from "./crew";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const REFRESH_DEBOUNCE_MS = 500;
const BACKSTOP_REFRESH_MS = 30_000;
const CLOCK_INTERVAL_MS = 15_000;

type CrewData = {
  entries: AgentEntry[];
  workspaceNames: ReadonlyMap<string, string>;
  truncated: boolean;
};

type CrewAction =
  | { kind: "send"; agentId: string; text: string; interrupted: boolean }
  | { kind: "detach"; agentId: string }
  | { kind: "archive"; agentId: string };

type PermissionRequest = AgentEntry["agent"]["pendingPermissions"][number];

type PermissionActionInput = {
  agentId: string;
  request: PermissionRequest;
  behavior: "allow" | "deny";
};

type PermissionDialogState = { node: CrewNode; request: PermissionRequest } | null;
type DialogState = { kind: "message" | "detach" | "archive"; node: CrewNode } | null;

async function loadAgents(paseo: PaseoApi): Promise<{ entries: AgentEntry[]; truncated: boolean }> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) return { entries, truncated: false };
  }
  return { entries, truncated: true };
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

async function loadCrewData(paseo: PaseoApi): Promise<CrewData> {
  const [agents, workspaces] = await Promise.all([loadAgents(paseo), loadWorkspaces(paseo)]);
  return {
    entries: agents.entries,
    truncated: agents.truncated,
    workspaceNames: new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
  };
}

function ActionButton({
  accessibilityLabel,
  color,
  disabled,
  icon,
  onPress,
}: {
  accessibilityLabel: string;
  color: string;
  disabled?: boolean;
  icon: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon name={icon} size={15} color={color} />
    </Pressable>
  );
}

function stateColor(
  state: CrewState,
  colors: PluginWorkspacePanelProps["theme"]["colors"],
): string {
  if (state === "failed") return colors.statusDanger;
  if (state === "needs-input") return colors.statusWarning;
  if (state === "ready") return colors.statusSuccess;
  if (state === "working") return colors.accent;
  return colors.foregroundMuted;
}

function permissionRequestText(request: PermissionRequest): string {
  return request.title ?? request.name;
}

function permissionRequestDetails(request: PermissionRequest): string {
  return [
    `Kind: ${request.kind}`,
    request.description ? `Description: ${request.description}` : null,
    request.input ? `Input: ${JSON.stringify(request.input, null, 2)}` : null,
    request.detail ? `Detail: ${JSON.stringify(request.detail, null, 2)}` : null,
    request.actions?.length
      ? `Actions: ${request.actions.map((action) => action.label).join(" · ")}`
      : null,
    request.suggestions?.length
      ? `Suggestions: ${JSON.stringify(request.suggestions, null, 2)}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function permissionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Permission decision failed";
  const lower = message.toLowerCase();
  if (
    lower.includes("already resolved") ||
    lower.includes("not pending") ||
    lower.includes("no longer pending") ||
    lower.includes("request not found")
  ) {
    return "Permission request was already resolved.";
  }
  if (lower.includes("network") || lower.includes("transport") || lower.includes("ipc")) {
    return "Could not reach the daemon to respond to the permission request.";
  }
  return message;
}

export function AgentCrew({
  theme,
  layout,
  host,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const workspaceTitle = useWorkspace(workspaceId, ({ name, title }) => title?.trim() || name);
  const queryKey = useMemo(() => ["agent-crew", "directory", host.id], [host.id]);
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => loadCrewData(paseo),
    refetchInterval: BACKSTOP_REFRESH_MS,
  });

  const [selectedState, setSelectedState] = useState<CrewState | null>(null);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [permissionDialog, setPermissionDialog] = useState<PermissionDialogState>(null);
  const [message, setMessage] = useState("");
  const [collapsedAgentIds, setCollapsedAgentIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void queryClient.invalidateQueries({ queryKey });
      }, REFRESH_DEBOUNCE_MS);
    };
    const unsubscribeAgents = paseo.agents.subscribe(invalidate);
    const unsubscribeWorkspaces = paseo.workspaces.subscribe(invalidate);
    return () => {
      clearTimeout(debounce);
      unsubscribeAgents();
      unsubscribeWorkspaces();
    };
  }, [paseo, queryClient, queryKey]);

  const allNodes = useMemo(
    () =>
      buildCrewForest(data?.entries ?? [], workspaceId, {
        state: null,
        query: "",
        workspaceNames: data?.workspaceNames,
      }),
    [data, workspaceId],
  );
  const nodes = useMemo(
    () =>
      buildCrewForest(data?.entries ?? [], workspaceId, {
        state: selectedState,
        query,
        workspaceNames: data?.workspaceNames,
      }),
    [data, query, selectedState, workspaceId],
  );
  const visibleNodes = useMemo(
    () => collapseCrewNodes(nodes, collapsedAgentIds),
    [collapsedAgentIds, nodes],
  );
  const counts = useMemo(() => crewCounts(allNodes), [allNodes]);
  const memberNodes = useMemo(() => allNodes.filter(({ member }) => member), [allNodes]);
  const crewCount = useMemo(
    () =>
      allNodes.filter(({ depth, descendantCount }) => depth === 0 && descendantCount > 0).length,
    [allNodes],
  );
  const externalCount = useMemo(
    () =>
      memberNodes.filter(
        ({ entry }) => entry.agent.workspaceId && entry.agent.workspaceId !== workspaceId,
      ).length,
    [memberNodes, workspaceId],
  );

  const action = useMutation({
    mutationFn: async (input: CrewAction) => {
      const handle = paseo.agents.ref(input.agentId);
      if (input.kind === "send") {
        await handle.send(input.text);
      } else if (input.kind === "detach") {
        await handle.detach();
      } else {
        await handle.archive();
      }
    },
    onSuccess: (_result, input) => {
      if (input.kind === "send") {
        toast.show(input.interrupted ? "Agent redirected" : "Nudge sent", { variant: "success" });
      } else if (input.kind === "detach") {
        toast.show("Subagent detached", { variant: "success" });
      } else {
        toast.show("Subagent archived", { variant: "success" });
      }
      setDialog(null);
      setMessage("");
    },
    onError: (mutationError) => {
      toast.error(mutationError instanceof Error ? mutationError.message : "Agent action failed");
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const permissionAction = useMutation({
    mutationFn: async (input: PermissionActionInput) => {
      await paseo.agents.ref(input.agentId).respondToPermission({
        requestId: input.request.id,
        response:
          input.behavior === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Denied from Agent Crew" },
      });
    },
    onSuccess: (_result, input) => {
      toast.show(input.behavior === "allow" ? "Permission allowed" : "Permission denied", {
        variant: "success",
      });
      setPermissionDialog(null);
    },
    onError: (mutationError) => {
      const message = permissionErrorMessage(mutationError);
      toast.error(message);
      if (message === "Permission request was already resolved.") {
        setPermissionDialog(null);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const panelStyles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.surface0,
        },
        header: {
          paddingHorizontal: layout.compact ? 14 : 20,
          paddingTop: layout.compact ? 14 : 18,
          paddingBottom: 12,
          gap: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        titleRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        },
        titleBlock: { flex: 1, minWidth: 0 },
        eyebrow: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "600",
          letterSpacing: 0.8,
          textTransform: "uppercase",
        },
        title: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 19 : 22,
          fontWeight: "700",
        },
        summary: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
        },
        toolbar: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        search: {
          flex: 1,
          minWidth: 120,
          height: 36,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          fontSize: 13,
        },
        refreshButton: {
          minHeight: 36,
          paddingHorizontal: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface1,
        },
        chipRail: { gap: 6 },
        chip: {
          minHeight: 30,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 9,
          borderRadius: 15,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        chipSelected: {
          borderColor: theme.colors.accent,
          backgroundColor: theme.colors.surface2,
        },
        chipText: { color: theme.colors.foregroundMuted, fontSize: 12 },
        chipTextSelected: { color: theme.colors.foreground, fontWeight: "600" },
        dot: { width: 7, height: 7, borderRadius: 4 },
        row: {
          minHeight: layout.compact ? 78 : 68,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 10,
          paddingRight: layout.compact ? 10 : 16,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        contextRow: { opacity: 0.58 },
        treeRail: {
          alignSelf: "stretch",
          width: 10,
          borderLeftWidth: 2,
          borderLeftColor: theme.colors.border,
        },
        rowBody: { flex: 1, minWidth: 0, gap: 3 },
        rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 7 },
        rowTitle: {
          flexShrink: 1,
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
        },
        rootRow: { backgroundColor: theme.colors.surface1 },
        childCount: { flexShrink: 0, color: theme.colors.foregroundMuted, fontSize: 11 },
        collapseSpacer: { width: 30, height: 30 },
        metadata: { color: theme.colors.foregroundMuted, fontSize: 11 },
        lastError: { color: theme.colors.statusDanger, fontSize: 11 },
        permissionCount: { color: theme.colors.statusWarning, fontSize: 11, fontWeight: "600" },
        statusColumn: { alignItems: "flex-end", gap: 5 },
        status: { fontSize: 11, fontWeight: "600" },
        age: { color: theme.colors.foregroundMuted, fontSize: 10 },
        rowActions: { flexDirection: "row", alignItems: "center", gap: 2 },
        empty: { padding: 24, gap: 6, alignItems: "center" },
        emptyTitle: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" },
        emptyBody: { color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" },
        error: {
          margin: 12,
          padding: 10,
          color: theme.colors.statusDanger,
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
        },
        contextBadge: {
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          fontWeight: "600",
          textTransform: "uppercase",
        },
        truncated: { paddingHorizontal: 16, paddingVertical: 8, color: theme.colors.statusWarning },
        modalBody: { gap: 14, padding: 18 },
        modalCopy: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
        messageInput: {
          minHeight: 112,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 8,
          padding: 10,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          textAlignVertical: "top",
        },
        modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
        secondaryButton: {
          minHeight: 36,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        primaryButton: {
          minHeight: 36,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 8,
          backgroundColor: theme.colors.accent,
        },
        dangerButton: { backgroundColor: theme.colors.statusDanger },
        buttonText: { color: theme.colors.foreground, fontWeight: "600", fontSize: 13 },
        primaryButtonText: {
          color: theme.colors.accentForeground,
          fontWeight: "600",
          fontSize: 13,
        },
        permissionBody: { gap: 12 },
        permissionSection: { gap: 4 },
        permissionLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
        permissionValue: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        permissionJson: {
          color: theme.colors.foreground,
          fontSize: 12,
          lineHeight: 17,
          fontFamily: "monospace",
          backgroundColor: theme.colors.surface1,
          borderRadius: 8,
          padding: 10,
        },
        permissionActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
        permissionButton: {
          minHeight: 36,
          justifyContent: "center",
          paddingHorizontal: 12,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        permissionPrimary: { backgroundColor: theme.colors.accent },
        permissionDeny: { backgroundColor: theme.colors.statusDanger },
        permissionButtonText: { color: theme.colors.foreground, fontWeight: "600", fontSize: 13 },
        permissionDenyText: { color: theme.colors.surface0, fontWeight: "600", fontSize: 13 },
        permissionPrimaryText: {
          color: theme.colors.accentForeground,
          fontWeight: "600",
          fontSize: 13,
        },
      }),
    [layout.compact, theme],
  );
  function openDialog(kind: NonNullable<DialogState>["kind"], node: CrewNode) {
    setMessage("");
    setDialog({ kind, node });
  }

  function submitDialog() {
    if (!dialog || action.isPending) return;
    const agent = dialog.node.entry.agent;
    if (dialog.kind === "message") {
      const text = message.trim();
      if (!text) return;
      action.mutate({ kind: "send", agentId: agent.id, text, interrupted: isWorking(agent) });
      return;
    }
    action.mutate({ kind: dialog.kind, agentId: agent.id });
  }

  function toggleCollapsed(agentId: string) {
    setCollapsedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  function openPermissionDialog(node: CrewNode, request: PermissionRequest) {
    setPermissionDialog({ node, request });
  }

  function submitPermissionAction(behavior: "allow" | "deny") {
    if (!permissionDialog || permissionAction.isPending) return;
    permissionAction.mutate({
      agentId: permissionDialog.node.entry.agent.id,
      request: permissionDialog.request,
      behavior,
    });
  }

  function renderRow({ item }: ListRenderItemInfo<CrewNode>) {
    const agent = item.entry.agent;
    const state = crewState(agent);
    const color = stateColor(state, theme.colors);
    const workspaceName = agent.workspaceId
      ? data?.workspaceNames.get(agent.workspaceId)
      : undefined;
    const external = Boolean(agent.workspaceId && agent.workspaceId !== workspaceId);
    const workspaceDetail = workspaceName
      ? `${external ? "Elsewhere: " : ""}${workspaceName}`
      : external
        ? "Elsewhere"
        : undefined;
    const providerModel = agent.model ? `${agent.provider}/${agent.model}` : agent.provider;
    const metadata = workspaceDetail ? `${providerModel} · ${workspaceDetail}` : providerModel;
    const age = formatAge(agentAgeTimestamp(agent), now);
    const expandable = item.descendantCount > 0;
    const collapsed = collapsedAgentIds.has(agent.id);
    const pendingPermissions = agent.pendingPermissions ?? [];
    const pendingPermission = pendingPermissions[0];
    const pendingPermissionCount = pendingPermissions.length;
    const rowBody = (
      <>
        <View style={panelStyles.rowTitleLine}>
          <View style={[panelStyles.dot, { backgroundColor: color }]} />
          <Text style={panelStyles.rowTitle} numberOfLines={1}>
            {agentTitle(item.entry)}
          </Text>
          {!item.member ? <Text style={panelStyles.contextBadge}>Context</Text> : null}
          {expandable ? (
            <Text style={panelStyles.childCount} numberOfLines={1}>
              {item.descendantCount} {item.descendantCount === 1 ? "descendant" : "descendants"}
            </Text>
          ) : null}
        </View>
        <Text style={panelStyles.metadata} numberOfLines={1}>
          {metadata}
        </Text>
        {agent.lastError ? (
          <Text style={panelStyles.lastError} numberOfLines={1}>
            {agent.lastError}
          </Text>
        ) : null}
      </>
    );

    return (
      <View
        style={[
          panelStyles.row,
          item.depth === 0 && panelStyles.rootRow,
          item.contextOnly && panelStyles.contextRow,
          { paddingLeft: 12 + Math.min(item.depth, 6) * 16 },
        ]}
      >
        {item.depth > 0 ? <View style={panelStyles.treeRail} /> : null}
        {expandable ? (
          <ActionButton
            accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${agentTitle(item.entry)}`}
            color={theme.colors.foregroundMuted}
            icon={collapsed ? "ChevronRight" : "ChevronDown"}
            onPress={() => toggleCollapsed(agent.id)}
          />
        ) : (
          <View style={panelStyles.collapseSpacer} />
        )}
        {navigation ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${agentTitle(item.entry)}`}
            onPress={() => navigation.openAgent({ agentId: agent.id })}
            style={({ pressed }) => [panelStyles.rowBody, pressed && styles.pressed]}
          >
            {rowBody}
          </Pressable>
        ) : (
          <View style={panelStyles.rowBody}>{rowBody}</View>
        )}
        <View style={panelStyles.statusColumn}>
          <Text
            style={[
              panelStyles.status,
              { color: item.member ? color : theme.colors.foregroundMuted },
            ]}
          >
            {item.member ? CREW_STATE_LABELS[state] : "Context"}
          </Text>
          {pendingPermissionCount > 0 ? (
            <Text style={panelStyles.permissionCount} numberOfLines={1}>
              {pendingPermissionCount} pending
            </Text>
          ) : null}
          {age ? <Text style={panelStyles.age}>{age}</Text> : null}
          {item.member ? (
            <View style={panelStyles.rowActions}>
              {pendingPermission ? (
                <ActionButton
                  accessibilityLabel={`Review ${pendingPermissionCount} pending permission ${pendingPermissionCount === 1 ? "request" : "requests"} for ${agentTitle(item.entry)}`}
                  color={theme.colors.statusWarning}
                  disabled={permissionAction.isPending}
                  icon="Lock"
                  onPress={() => openPermissionDialog(item, pendingPermission)}
                />
              ) : null}
              {agent.status !== "closed" ? (
                <ActionButton
                  accessibilityLabel={`${isWorking(agent) ? "Interrupt and redirect" : "Nudge"} ${agentTitle(item.entry)}`}
                  color={
                    isWorking(agent) ? theme.colors.statusWarning : theme.colors.foregroundMuted
                  }
                  disabled={action.isPending}
                  icon={isWorking(agent) ? "CornerDownRight" : "MessageSquareMore"}
                  onPress={() => openDialog("message", item)}
                />
              ) : null}
              {parentAgentId(agent) ? (
                <ActionButton
                  accessibilityLabel={`Detach ${agentTitle(item.entry)}`}
                  color={theme.colors.foregroundMuted}
                  disabled={action.isPending}
                  icon="Unlink"
                  onPress={() => openDialog("detach", item)}
                />
              ) : null}
              <ActionButton
                accessibilityLabel={`Archive ${agentTitle(item.entry)}`}
                color={theme.colors.foregroundMuted}
                disabled={action.isPending}
                icon="Archive"
                onPress={() => openDialog("archive", item)}
              />
            </View>
          ) : null}
        </View>
      </View>
    );
  }
  const currentWorkspaceTitle = workspaceTitle?.trim() || "Current workspace";
  let dialogTitle = "";
  let dialogCopy = "";
  let confirmLabel = "";
  if (dialog) {
    const target = agentTitle(dialog.node.entry);
    if (dialog.kind === "message") {
      const state = crewState(dialog.node.entry.agent);
      const running = isWorking(dialog.node.entry.agent);
      dialogTitle = running ? `Interrupt and redirect ${target}` : `Nudge ${target}`;
      dialogCopy = running
        ? "This agent is working. Sending a message stops its current turn and starts the new direction."
        : state === "needs-input"
          ? "This agent is waiting for a permission decision. Sending a message dismisses that request and starts the new direction."
          : "Send a concise follow-up with the missing context or next step.";
      confirmLabel = running
        ? "Interrupt & redirect"
        : state === "needs-input"
          ? "Dismiss request & nudge"
          : "Send nudge";
    } else if (dialog.kind === "detach") {
      dialogTitle = `Detach ${target}?`;
      dialogCopy =
        dialog.node.descendantCount > 0
          ? `This agent and its ${dialog.node.descendantCount} descendants will leave this crew view and continue as standalone agents.`
          : "This agent will leave this crew view and continue as a standalone agent.";
      confirmLabel = "Detach";
    } else {
      dialogTitle = `Archive ${target}?`;
      dialogCopy =
        dialog.node.descendantCount > 0
          ? `This agent has ${dialog.node.descendantCount} managed descendants. Same-workspace descendants are archived with it; cross-workspace descendants detach and continue.`
          : isWorking(dialog.node.entry.agent)
            ? "This agent is still working. Archiving stops it and removes it from the crew."
            : "This agent will stop and be removed from the crew.";
      confirmLabel = "Archive";
    }
  }
  const permissionDialogTitle = permissionDialog
    ? `Permission request from ${agentTitle(permissionDialog.node.entry)}`
    : "Permission request";

  return (
    <View style={panelStyles.screen}>
      <View style={panelStyles.header}>
        <View style={panelStyles.titleRow}>
          <View style={panelStyles.titleBlock}>
            <Text style={panelStyles.eyebrow}>Agent Crew</Text>
            <Text style={panelStyles.title} numberOfLines={1}>
              {currentWorkspaceTitle}
            </Text>
            <Text style={panelStyles.summary}>
              {memberNodes.length} {memberNodes.length === 1 ? "agent" : "agents"} · {crewCount}{" "}
              {crewCount === 1 ? "crew" : "crews"}
              {externalCount > 0 ? ` · ${externalCount} elsewhere` : ""}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh Agent Crew"
            onPress={() => void refetch()}
            style={({ pressed }) => [panelStyles.refreshButton, pressed && styles.pressed]}
          >
            <Icon
              name="RefreshCw"
              size={16}
              color={isFetching ? theme.colors.accent : theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
        <View style={panelStyles.toolbar}>
          <TextInput
            accessibilityLabel="Filter agents"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder="Filter by task, model, workspace"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={query}
            style={panelStyles.search}
          />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={panelStyles.chipRail}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: selectedState === null }}
            onPress={() => setSelectedState(null)}
            style={[panelStyles.chip, selectedState === null && panelStyles.chipSelected]}
          >
            <Text
              style={[panelStyles.chipText, selectedState === null && panelStyles.chipTextSelected]}
            >
              All {memberNodes.length}
            </Text>
          </Pressable>
          {CREW_STATES.map((state) => (
            <Pressable
              key={state}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedState === state }}
              onPress={() => setSelectedState(state)}
              style={[panelStyles.chip, selectedState === state && panelStyles.chipSelected]}
            >
              <View
                style={[panelStyles.dot, { backgroundColor: stateColor(state, theme.colors) }]}
              />
              <Text
                style={[
                  panelStyles.chipText,
                  selectedState === state && panelStyles.chipTextSelected,
                ]}
              >
                {CREW_STATE_LABELS[state]} {counts[state]}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {data?.truncated ? (
        <Text style={panelStyles.truncated}>
          Showing the first {PAGE_LIMIT * MAX_PAGES} daemon agents. Some agents in this workspace or
          their crew may be missing.
        </Text>
      ) : null}
      {error ? (
        <Text style={panelStyles.error}>
          {error instanceof Error ? error.message : "Could not load agents"}
        </Text>
      ) : null}
      <FlatList
        data={visibleNodes}
        keyExtractor={(node) => node.entry.agent.id}
        renderItem={renderRow}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={panelStyles.empty}>
            <Icon name="Network" size={24} color={theme.colors.foregroundMuted} />
            <Text style={panelStyles.emptyTitle}>
              {isPending
                ? "Loading crew"
                : memberNodes.length === 0
                  ? "No agents yet"
                  : "No matches"}
            </Text>
            <Text style={panelStyles.emptyBody}>
              {isPending
                ? "Reading this workspace’s agents."
                : memberNodes.length === 0
                  ? "Start an agent or ask one to delegate. Crews will appear here."
                  : "Change the status filter or search text."}
            </Text>
          </View>
        }
      />

      <Modal
        title={dialogTitle}
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !action.isPending) {
            setDialog(null);
            setMessage("");
          }
        }}
        icon={
          dialog ? (
            <Icon
              name={
                dialog.kind === "message"
                  ? "MessageSquareMore"
                  : dialog.kind === "detach"
                    ? "Unlink"
                    : "Archive"
              }
              size={18}
              color={
                dialog.kind === "archive" ? theme.colors.statusDanger : theme.colors.foreground
              }
            />
          ) : undefined
        }
      >
        <Modal.Content>
          <View style={panelStyles.modalBody}>
            <Text style={panelStyles.modalCopy}>{dialogCopy}</Text>
            {dialog?.kind === "message" ? (
              <TextInput
                accessibilityLabel="Message to subagent"
                autoFocus
                multiline
                onChangeText={setMessage}
                placeholder="What should this agent do next?"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={message}
                style={panelStyles.messageInput}
              />
            ) : null}
            <View style={panelStyles.modalActions}>
              <Pressable
                accessibilityRole="button"
                disabled={action.isPending}
                onPress={() => {
                  setDialog(null);
                  setMessage("");
                }}
                style={({ pressed }) => [panelStyles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={panelStyles.buttonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={action.isPending || (dialog?.kind === "message" && !message.trim())}
                onPress={submitDialog}
                style={({ pressed }) => [
                  panelStyles.primaryButton,
                  dialog?.kind === "archive" && panelStyles.dangerButton,
                  pressed && styles.pressed,
                  (action.isPending || (dialog?.kind === "message" && !message.trim())) &&
                    styles.disabled,
                ]}
              >
                <Text style={panelStyles.primaryButtonText}>
                  {action.isPending ? "Working…" : confirmLabel}
                </Text>
              </Pressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title={permissionDialogTitle}
        open={permissionDialog !== null}
        onOpenChange={(open) => {
          if (!open && !permissionAction.isPending) {
            setPermissionDialog(null);
          }
        }}
        icon={
          permissionDialog ? (
            <Icon name="Lock" size={18} color={theme.colors.foreground} />
          ) : undefined
        }
      >
        <Modal.Content contentContainerStyle={panelStyles.permissionBody}>
          {permissionDialog ? (
            <>
              <Text style={panelStyles.modalCopy}>
                Review the pending permission request below. Allow or deny it explicitly.
              </Text>
              <View style={panelStyles.permissionSection}>
                <Text style={panelStyles.permissionLabel}>Request</Text>
                <Text style={panelStyles.permissionValue}>
                  {permissionRequestText(permissionDialog.request)}
                </Text>
              </View>
              <View style={panelStyles.permissionSection}>
                <Text style={panelStyles.permissionLabel}>Kind</Text>
                <Text style={panelStyles.permissionValue}>{permissionDialog.request.kind}</Text>
              </View>
              {permissionDialog.request.description ? (
                <View style={panelStyles.permissionSection}>
                  <Text style={panelStyles.permissionLabel}>Description</Text>
                  <Text style={panelStyles.permissionValue}>
                    {permissionDialog.request.description}
                  </Text>
                </View>
              ) : null}
              <View style={panelStyles.permissionSection}>
                <Text style={panelStyles.permissionLabel}>Payload</Text>
                <Text selectable style={panelStyles.permissionJson}>
                  {permissionRequestDetails(permissionDialog.request)}
                </Text>
              </View>
              <View style={panelStyles.permissionActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={permissionAction.isPending}
                  onPress={() => setPermissionDialog(null)}
                  style={({ pressed }) => [panelStyles.permissionButton, pressed && styles.pressed]}
                >
                  <Text style={panelStyles.permissionButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={permissionAction.isPending}
                  onPress={() => submitPermissionAction("deny")}
                  style={({ pressed }) => [
                    panelStyles.permissionButton,
                    panelStyles.permissionDeny,
                    pressed && styles.pressed,
                    permissionAction.isPending && styles.disabled,
                  ]}
                >
                  <Text style={panelStyles.permissionDenyText}>
                    {permissionAction.isPending ? "Working…" : "Deny"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={permissionAction.isPending}
                  onPress={() => submitPermissionAction("allow")}
                  style={({ pressed }) => [
                    panelStyles.permissionButton,
                    panelStyles.permissionPrimary,
                    pressed && styles.pressed,
                    permissionAction.isPending && styles.disabled,
                  ]}
                >
                  <Text style={panelStyles.permissionPrimaryText}>
                    {permissionAction.isPending ? "Working…" : "Allow"}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
  },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.38 },
});
