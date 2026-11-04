import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  addOmpMcp,
  cancelOmpMcpAuth,
  listOmpMcps,
  type OmpMcpAction,
  OmpMcpNameSchema,
  type OmpMcpServer,
  OmpMcpTargetSchema,
  runOmpMcpAction,
  startOmpMcpAuth,
  submitOmpMcpAuthCode,
} from "../shared/omp-mcps";
import { type OmpStore, storeLabel } from "../shared/omp-store";
import { ActionButton, ConfirmModal, describe, LoginProgress } from "./omp-accounts-section";
import { loginIsOpen } from "./omp-accounts-state";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";

type Theme = PluginSurfaceProps["theme"];

/** Kept apart from the config editor's `paseo-omp` key so MCP work never locks setting edits. */
const MCPS_KEY = ["paseo-omp-mcps"] as const;
const OPEN_AUTH_POLL_MS = 1_000;

function McpCard({
  server,
  theme,
  styles,
  busy,
  authorizing,
  onAuthorize,
  onAction,
  onRemove,
}: {
  server: OmpMcpServer;
  theme: Theme;
  styles: OmpConfigStyles;
  busy: boolean;
  authorizing: boolean;
  onAuthorize(): void;
  onAction(action: OmpMcpAction): void;
  onRemove(): void;
}) {
  const disabled = server.state === "disabled";
  // Only a remote server signs in with OAuth; a local one is a process OMP starts.
  const remote = server.transport === "http" || server.transport === "sse";
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text numberOfLines={1} style={[styles.cardTitle, { flexShrink: 1 }]}>
          {server.name}
        </Text>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{server.transport}</Text>
        </View>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{server.state}</Text>
        </View>
      </View>
      <Text numberOfLines={2} style={styles.muted}>
        {server.target}
      </Text>
      <Text style={styles.collectionSummary}>{`From ${server.source}`}</Text>
      <View style={styles.row}>
        {remote ? (
          <ActionButton
            styles={styles}
            theme={theme}
            label={authorizing ? "Starting..." : "Authorize"}
            tone="primary"
            disabled={busy || authorizing}
            onPress={onAuthorize}
          />
        ) : null}
        <ActionButton
          styles={styles}
          theme={theme}
          label="Test"
          disabled={busy}
          onPress={() => onAction("test")}
        />
        <ActionButton
          styles={styles}
          theme={theme}
          label={disabled ? "Enable" : "Disable"}
          disabled={busy}
          onPress={() => onAction(disabled ? "enable" : "disable")}
        />
        {server.source === "user" ? (
          <ActionButton
            styles={styles}
            theme={theme}
            label="Remove"
            tone="danger"
            disabled={busy}
            onPress={onRemove}
          />
        ) : null}
      </View>
    </View>
  );
}

function AddMcpModal({
  styles,
  theme,
  busy,
  error,
  onAdd,
  onClose,
}: {
  styles: OmpConfigStyles;
  theme: Theme;
  busy: boolean;
  error: string | null;
  onAdd(input: { name: string; target: string }): void;
  onClose(): void;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const valid =
    OmpMcpNameSchema.safeParse(name.trim()).success && OmpMcpTargetSchema.safeParse(target).success;
  return (
    <Modal
      title="Add MCP server"
      open
      onOpenChange={(open) => (open || busy ? undefined : onClose())}
    >
      <Modal.Content>
        <Text style={styles.collectionSummary}>Adds the server to OMP's user MCP file</Text>
        <Text style={styles.muted}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="docs"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="MCP server name"
          style={styles.scalarInput}
        />
        <Text style={styles.muted}>Server URL, or the command that starts it</Text>
        <TextInput
          value={target}
          onChangeText={setTarget}
          placeholder="https://mcp.example.com/mcp"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="MCP server URL or command"
          onSubmitEditing={() => valid && onAdd({ name: name.trim(), target })}
          style={styles.scalarInput}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <ActionButton
            styles={styles}
            theme={theme}
            label="Cancel"
            disabled={busy}
            onPress={onClose}
          />
          <ActionButton
            styles={styles}
            theme={theme}
            label={busy ? "Adding..." : "Add"}
            tone="primary"
            disabled={busy || !valid}
            onPress={() => onAdd({ name: name.trim(), target })}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function OmpMcpsSection({
  theme,
  styles,
  store,
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  store?: OmpStore;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const load = useRpc(listOmpMcps);
  const act = useRpc(runOmpMcpAction);
  const addServer = useRpc(addOmpMcp);
  const start = useRpc(startOmpMcpAuth);
  const submit = useRpc(submitOmpMcpAuthCode);
  const cancel = useRpc(cancelOmpMcpAuth);
  const [adding, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [authId, setAuthId] = useState<string | null>(null);
  const queryKey = [...MCPS_KEY, ompStoreKey(store)];
  const mcps = useQuery({
    queryKey,
    queryFn: () => load({ store }),
    refetchInterval: (query) =>
      query.state.data?.auths.some(loginIsOpen) ? OPEN_AUTH_POLL_MS : false,
  });
  const refresh = useMutation({
    mutationKey: [...MCPS_KEY, "refresh"],
    mutationFn: () => load({ store, refresh: true }),
    onSuccess: (view) => queryClient.setQueryData(queryKey, view),
    onError: (error) => toast.error(describe(error)),
  });
  const run = useMutation({
    mutationKey: [...MCPS_KEY, "run"],
    mutationFn: (change: { name: string; action: OmpMcpAction }) => act({ store, ...change }),
    onSuccess: async (result) => {
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      await queryClient.invalidateQueries({ queryKey: MCPS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
    onSettled: () => setPendingRemove(null),
  });
  const add = useMutation({
    mutationKey: [...MCPS_KEY, "add"],
    mutationFn: (input: { name: string; target: string }) => addServer({ store, ...input }),
    onSuccess: async (result) => {
      if (!result.ok) return;
      toast.show(result.message, { variant: "success" });
      setAdding(false);
      await queryClient.invalidateQueries({ queryKey: MCPS_KEY });
    },
  });
  const authorize = useMutation({
    mutationKey: [...MCPS_KEY, "authorize"],
    mutationFn: (name: string) => start({ store, name }),
    onSuccess: async (started) => {
      setAuthId(started.id);
      await queryClient.invalidateQueries({ queryKey: MCPS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
  });

  const view = mcps.data;
  const auth = authId ? view?.auths.find((entry) => entry.id === authId) : undefined;
  const addFailure = add.data && !add.data.ok ? add.data.message : null;
  const addError = add.error ? describe(add.error) : addFailure;

  function closeAuth() {
    // An open authorization holds OMP's OAuth callback port until it is canceled.
    if (auth && loginIsOpen(auth)) cancel({ store, authId: auth.id }).catch(() => undefined);
    setAuthId(null);
    void queryClient.invalidateQueries({ queryKey: MCPS_KEY });
  }

  function openAdd() {
    add.reset();
    setAdding(true);
  }

  return (
    <>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>MCP servers</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh OMP MCP servers"
            style={styles.refresh}
            disabled={refresh.isPending}
            onPress={() => refresh.mutate()}
          >
            <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
            <Text style={styles.refreshLabel}>
              {refresh.isPending ? "Refreshing..." : "Refresh"}
            </Text>
          </Pressable>
          <ActionButton
            styles={styles}
            theme={theme}
            label="Add server"
            tone="primary"
            disabled={view === undefined || !view.installed}
            onPress={openAdd}
          />
        </View>
        <Text style={styles.source}>{storeLabel(store)}</Text>
      </View>
      <Text style={styles.muted}>
        The MCP servers OMP connects to, read and changed through omp itself, so the terminal sees
        the same list. Authorize signs a remote server in through your browser.
      </Text>
      {mcps.isLoading ? <Text style={styles.muted}>Loading OMP MCP servers...</Text> : null}
      {mcps.error ? (
        <Text
          style={styles.error}
        >{`Could not read OMP's MCP servers: ${describe(mcps.error)}`}</Text>
      ) : null}
      {view && !view.installed ? (
        <Text style={styles.muted}>The omp command was not found on this host.</Text>
      ) : null}
      {view?.error ? <Text style={styles.error}>{view.error}</Text> : null}
      {view?.installed && !view.error && view.servers.length === 0 ? (
        <Text style={styles.muted}>No MCP servers yet. Add one to get started.</Text>
      ) : null}
      {view?.servers.map((server) => (
        <McpCard
          key={`${server.source}/${server.name}`}
          server={server}
          theme={theme}
          styles={styles}
          busy={run.isPending}
          authorizing={authorize.isPending && authorize.variables === server.name}
          onAuthorize={() => authorize.mutate(server.name)}
          onAction={(action) => run.mutate({ name: server.name, action })}
          onRemove={() => setPendingRemove(server.name)}
        />
      ))}
      {adding ? (
        <AddMcpModal
          styles={styles}
          theme={theme}
          busy={add.isPending}
          error={addError}
          onAdd={(input) => add.mutate(input)}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {pendingRemove ? (
        <ConfirmModal
          styles={styles}
          theme={theme}
          title={`Remove ${pendingRemove}?`}
          body="This deletes the server from OMP's user MCP file, for the terminal too. Its OAuth sign-in is kept."
          confirmLabel="Remove"
          tone="danger"
          busy={run.isPending}
          onConfirm={() => run.mutate({ name: pendingRemove, action: "remove" })}
          onCancel={() => setPendingRemove(null)}
        />
      ) : null}
      {auth ? (
        <Modal
          title={`Authorize ${auth.name}`}
          open
          onOpenChange={(open) => (open ? undefined : closeAuth())}
        >
          <Modal.Content>
            <LoginProgress
              styles={styles}
              theme={theme}
              login={auth}
              onSubmit={async (code) => {
                await submit({ store, authId: auth.id, code });
                await queryClient.invalidateQueries({ queryKey: MCPS_KEY });
              }}
              onRetry={() => authorize.mutate(auth.name)}
              onClose={closeAuth}
            />
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
