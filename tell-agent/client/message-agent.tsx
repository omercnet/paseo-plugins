import {
  type PluginButtonContentProps,
  type PluginClientContext,
  usePaseo,
} from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  AGENT_PAGE_LIMIT,
  type AgentEntry,
  loadAgents,
  MAX_AGENT_PAGES,
  placement,
  stateLabel,
  title,
} from "./agents";
import {
  formatCrossSessionMessage,
  messageTargets,
  parseTellArguments,
  resolveMessageTarget,
} from "./messaging";

const VISIBLE_TARGETS = 8;

function MessageAgentForm({
  sourceAgentId,
  theme,
  host,
  close,
}: PluginButtonContentProps & { sourceAgentId: string }) {
  const paseo = usePaseo();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const directory = useQuery({
    queryKey: ["tell-agent", "message-targets", host.id],
    queryFn: () => loadAgents(paseo),
  });
  const entries = directory.data?.entries ?? [];
  const source = entries.find((entry) => entry.agent.id === sourceAgentId);
  const target = targetId ? entries.find((entry) => entry.agent.id === targetId) : undefined;
  const matchingTargets = useMemo(
    () => messageTargets(entries, sourceAgentId, query),
    [entries, query, sourceAgentId],
  );
  const visibleTargets = matchingTargets.slice(0, VISIBLE_TARGETS);
  const send = useMutation({
    mutationFn: async ({ entry, text }: { entry: AgentEntry; text: string }) => {
      await paseo.agents
        .ref(entry.agent.id)
        .send(formatCrossSessionMessage(source, sourceAgentId, text));
      return entry;
    },
    onSuccess(entry) {
      toast.show(`Message sent to ${title(entry)}`, { variant: "success" });
      close();
    },
  });
  const styles = useMemo(
    () => ({
      body: { gap: 12 },
      heading: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 },
      warning: { color: theme.colors.statusWarning, fontSize: 13, lineHeight: 18 },
      input: {
        minHeight: 38,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
      },
      message: {
        minHeight: 92,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        textAlignVertical: "top" as const,
      },
      results: { gap: 6 },
      row: {
        minHeight: 48,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 9,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      rowSelected: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface2,
      },
      rowText: { flex: 1, minWidth: 0, gap: 2 },
      rowTitle: { color: theme.colors.foreground, fontWeight: "600" as const, fontSize: 13 },
      rowDetail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      state: { color: theme.colors.foregroundMuted, fontSize: 11 },
      actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8 },
      button: {
        minHeight: 36,
        justifyContent: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      primary: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontWeight: "600" as const },
      primaryText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      disabled: { opacity: 0.4 },
    }),
    [theme],
  );
  const targetIsWorking =
    target?.agent.status === "running" || target?.agent.status === "initializing";
  const targetHasPermission = (target?.agent.pendingPermissions.length ?? 0) > 0;
  const canSend = Boolean(target && message.trim()) && !send.isPending;

  return (
    <View style={styles.body}>
      <Text style={styles.heading}>Message another agent</Text>
      <Text style={styles.detail}>
        Search every active session on {host.label}. The current session is excluded.
      </Text>
      <TextInput
        accessibilityLabel="Search message targets"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search agent, workspace, project, or model"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={query}
        style={styles.input}
      />
      {directory.isPending ? <Text style={styles.detail}>Loading agents…</Text> : null}
      {directory.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {directory.error.message}
        </Text>
      ) : null}
      {!directory.isPending && !directory.error ? (
        <View style={styles.results}>
          {visibleTargets.map((entry) => {
            const selected = entry.agent.id === targetId;
            return (
              <Pressable
                key={entry.agent.id}
                accessibilityRole="button"
                accessibilityLabel={`Select ${title(entry)} in ${placement(entry)}`}
                accessibilityState={{ selected }}
                onPress={() => setTargetId(entry.agent.id)}
                style={({ pressed }) => [
                  styles.row,
                  selected && styles.rowSelected,
                  pressed && styles.disabled,
                ]}
              >
                <Icon
                  name={selected ? "CircleCheck" : "MessageSquareMore"}
                  size={16}
                  color={selected ? theme.colors.accent : theme.colors.foregroundMuted}
                />
                <View style={styles.rowText}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {title(entry)}
                  </Text>
                  <Text numberOfLines={1} style={styles.rowDetail}>
                    {placement(entry)}
                  </Text>
                </View>
                <Text style={styles.state}>{stateLabel(entry.agent)}</Text>
              </Pressable>
            );
          })}
          {matchingTargets.length === 0 ? (
            <Text style={styles.detail}>No active agents match this search.</Text>
          ) : null}
          {matchingTargets.length > VISIBLE_TARGETS ? (
            <Text style={styles.detail}>
              Showing {VISIBLE_TARGETS} of {matchingTargets.length}. Refine the search to narrow it.
            </Text>
          ) : null}
          {directory.data?.truncated ? (
            <Text style={styles.warning}>
              Only the first {AGENT_PAGE_LIMIT * MAX_AGENT_PAGES} agents were searched.
            </Text>
          ) : null}
        </View>
      ) : null}
      {target ? (
        <>
          <TextInput
            accessibilityLabel={`Message to ${title(target)}`}
            multiline
            onChangeText={setMessage}
            placeholder="What should this agent do?"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={message}
            style={styles.message}
          />
          {targetIsWorking ? (
            <Text style={styles.warning}>
              This agent is working. Sending stops its current turn and starts this direction.
            </Text>
          ) : targetHasPermission ? (
            <Text style={styles.warning}>
              This agent is waiting for permission. Sending dismisses that request and starts this
              direction.
            </Text>
          ) : null}
        </>
      ) : null}
      {send.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {send.error.message}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={send.isPending}
          onPress={close}
          style={({ pressed }) => [styles.button, pressed && styles.disabled]}
        >
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={target ? `Send message to ${title(target)}` : "Select a target agent"}
          disabled={!canSend}
          onPress={() => {
            if (target && message.trim()) send.mutate({ entry: target, text: message });
          }}
          style={({ pressed }) => [
            styles.button,
            styles.primary,
            (!canSend || pressed) && styles.disabled,
          ]}
        >
          <Text style={styles.primaryText}>
            {send.isPending
              ? "Sending…"
              : targetIsWorking
                ? "Interrupt & send"
                : targetHasPermission
                  ? "Dismiss & send"
                  : "Send message"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function MessageAgentPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <MessageAgentForm {...props} sourceAgentId={props.agentId} />;
}

export function contributeAgentMessaging(client: PluginClientContext) {
  const pills = new Map<string, { workspaceId: string; remove(): void }>();
  let stopped = false;

  function removePill(agentId: string) {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  }

  function syncAgent(agent: {
    id: string;
    workspaceId?: string | null;
    status: string;
    archivedAt?: string | null;
  }) {
    if (!agent.workspaceId || agent.archivedAt || agent.status === "closed") {
      removePill(agent.id);
      return;
    }
    const next = { id: agent.id, workspaceId: agent.workspaceId };
    const current = pills.get(agent.id);
    if (current?.workspaceId === next.workspaceId) return;
    removePill(agent.id);
    const pill = client.addComposerPill({
      id: "message-agent",
      workspaceId: next.workspaceId,
      agentId: next.id,
      button: {
        title: "Message another agent",
        label: "Tell agent",
        icon: "MessagesSquare",
        behavior: { kind: "popover", Content: MessageAgentPopover },
      },
    });
    pills.set(agent.id, { workspaceId: next.workspaceId, remove: pill.remove });
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      removePill(update.agentId);
      return;
    }
    syncAgent(update.agent);
  });

  void loadAgents(client.paseo)
    .then(({ entries }) => {
      if (stopped) return;
      for (const { agent } of entries) syncAgent(agent);
    })
    .catch(() => undefined);

  const removeTellCommand = client.addSlashCommand({
    name: "tell",
    description: "Message another agent session",
    argumentHint: "<agent or workspace> :: <message>",
    context: "agent",
    async onSubmit({ args, agent, paseo }) {
      const parsed = parseTellArguments(args);
      if (!parsed) {
        throw new Error("Usage: /tell <agent or workspace> :: <message>");
      }
      const { entries } = await loadAgents(paseo);
      const resolution = resolveMessageTarget(entries, agent.id, parsed.target);
      if (resolution.kind === "none") {
        throw new Error(`No active agent matches “${parsed.target}”.`);
      }
      if (resolution.kind === "ambiguous") {
        const examples = resolution.entries
          .slice(0, 3)
          .map((entry) => `${title(entry)} (${placement(entry)})`)
          .join(", ");
        throw new Error(`More than one agent matches “${parsed.target}”: ${examples}. Refine it.`);
      }
      const target = resolution.entry;
      const working = target.agent.status === "running" || target.agent.status === "initializing";
      if (working || target.agent.pendingPermissions.length > 0) {
        throw new Error(
          `${title(target)} is ${working ? "working" : "waiting for permission"}. Use the Tell agent pill to review and confirm the interruption.`,
        );
      }
      const source = entries.find((entry) => entry.agent.id === agent.id);
      await paseo.agents
        .ref(target.agent.id)
        .send(formatCrossSessionMessage(source, agent.id, parsed.message));
    },
  });

  return () => {
    if (stopped) return;
    stopped = true;
    removeTellCommand();
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
