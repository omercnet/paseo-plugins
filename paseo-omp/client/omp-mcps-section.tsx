import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  Modal,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
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
import type { OmpStore } from "../shared/omp-store";
import { ConfirmModal, describe, LoginProgress } from "./omp-accounts-section";
import { loginIsOpen } from "./omp-accounts-state";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";

type Theme = PluginSurfaceProps["theme"];

/** Kept apart from the config editor's `paseo-omp` key so MCP work never locks setting edits. */
const MCPS_KEY = ["paseo-omp-mcps"] as const;
const OPEN_AUTH_POLL_MS = 1_000;
const TEST_HINT = "Connects and lists its tools";

/** What the last test or add check said about one server; shown on its own row. */
interface Outcome {
  ok: boolean;
  message: string;
}

interface ServerSectionProps {
  styles: OmpConfigStyles;
  server: OmpMcpServer;
  outcome: Outcome | undefined;
  busy: boolean;
  testing: boolean;
  authorizing: boolean;
  onToggle(enabled: boolean): void;
  onTest(): void;
  onAuthorize(): void;
  onRemove(): void;
}

function ServerSection({
  styles,
  server,
  outcome,
  busy,
  testing,
  authorizing,
  onToggle,
  onTest,
  onAuthorize,
  onRemove,
}: ServerSectionProps) {
  // Only a remote server signs in with OAuth; a local one is a process OMP starts.
  const remote = server.transport === "http" || server.transport === "sse";
  const failed = outcome !== undefined && !outcome.ok;
  // OMP allows names the plugin cannot pass as one command argument. Such a server is shown with
  // its address and no actions, because every action would be refused.
  if (!OmpMcpNameSchema.safeParse(server.name).success) {
    return (
      <SettingsSection
        title={server.name}
        trailing={<Text style={styles.muted}>{`${server.transport} · ${server.source}`}</Text>}
      >
        <SettingsCard>
          <SettingsRow label={server.target} />
          <SettingsRow
            label="Manage in the OMP terminal"
            hint="Its name has spaces or other characters this plugin cannot pass to omp safely"
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection
      title={server.name}
      trailing={<Text style={styles.muted}>{`${server.transport} · ${server.source}`}</Text>}
    >
      <SettingsCard>
        <SettingsRow label={server.target} />
        <SettingsSwitch
          label="Enabled"
          hint="Whether OMP connects to it"
          value={server.state === "enabled"}
          disabled={busy}
          onValueChange={onToggle}
        />
        <SettingsAction
          label="Test connection"
          hint={outcome?.ok ? outcome.message : TEST_HINT}
          error={failed ? outcome.message : null}
          actionLabel={testing ? "Testing..." : "Test"}
          disabled={busy}
          onPress={onTest}
        />
        {remote ? (
          <SettingsAction
            label="Sign in"
            hint="Authorize through your browser"
            actionLabel={authorizing ? "Starting..." : "Authorize"}
            disabled={busy || authorizing}
            onPress={onAuthorize}
          />
        ) : null}
        {server.source === "user" ? (
          <SettingsAction
            label="Remove server"
            hint="Deletes it from OMP's user MCP file"
            actionLabel="Remove"
            disabled={busy}
            onPress={onRemove}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function AddMcpModal({
  busy,
  error,
  onAdd,
  onEdit,
  onClose,
}: {
  busy: boolean;
  error: string | null;
  onAdd(input: { name: string; target: string }): void;
  /** The person changed a field, so the last attempt's error no longer describes it. */
  onEdit(): void;
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
        <SettingsCard>
          <SettingsInput
            label="Name"
            placeholder="docs"
            onChangeText={(value) => {
              setName(value);
              if (error) onEdit();
            }}
          />
          <SettingsInput
            label="Address"
            hint="A URL, or the command that starts the server"
            placeholder="https://mcp.example.com/mcp"
            error={error}
            onChangeText={(value) => {
              setTarget(value);
              if (error) onEdit();
            }}
          />
          <SettingsAction
            label="Add to OMP"
            hint="Adds it to OMP's user MCP file, then tests the connection"
            actionLabel={busy ? "Adding..." : "Add"}
            disabled={busy || !valid}
            onPress={() => onAdd({ name: name.trim(), target })}
          />
        </SettingsCard>
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
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const queryKey = [...MCPS_KEY, ompStoreKey(store)];
  const mcps = useQuery({
    queryKey,
    queryFn: () => load({ store }),
    refetchInterval: (query) =>
      query.state.data?.auths.some(loginIsOpen) ? OPEN_AUTH_POLL_MS : false,
  });

  function remember(name: string, outcome: Outcome | null) {
    setOutcomes((previous) => {
      const next = new Map(previous);
      if (outcome) next.set(name, outcome);
      else next.delete(name);
      return next;
    });
  }

  const refresh = useMutation({
    mutationKey: [...MCPS_KEY, "refresh"],
    mutationFn: () => load({ store, refresh: true }),
    onSuccess: (view) => queryClient.setQueryData(queryKey, view),
    onError: (error) => toast.error(describe(error)),
  });
  const run = useMutation({
    mutationKey: [...MCPS_KEY, "run"],
    mutationFn: (change: { name: string; action: OmpMcpAction }) => act({ store, ...change }),
    onSuccess: async (result, { name, action }) => {
      if (action === "test") remember(name, result);
      else if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      if (action === "remove" && result.ok) remember(name, null);
      await queryClient.invalidateQueries({ queryKey: MCPS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
    onSettled: () => setPendingRemove(null),
  });
  const add = useMutation({
    mutationKey: [...MCPS_KEY, "add"],
    mutationFn: (input: { name: string; target: string }) => addServer({ store, ...input }),
    onSuccess: async (result, { name }) => {
      if (!result.ok) return;
      const healthy = result.check !== "failed";
      remember(name, { ok: healthy, message: result.message });
      toast.show(result.message, { variant: healthy ? "success" : "warning" });
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

  const notice = mcps.error
    ? `Could not read OMP's MCP servers: ${describe(mcps.error)}`
    : (view?.error ?? null);

  return (
    <View style={{ gap: 12 }}>
      <SettingsSection
        title="MCP servers"
        info="The servers OMP connects to, read and changed through omp itself, so the terminal sees the same list."
      >
        <SettingsCard>
          <SettingsAction
            label="Add server"
            hint="Connect OMP to a URL or a local command"
            actionLabel="Add"
            disabled={view === undefined || !view.installed}
            onPress={openAdd}
          />
          <SettingsAction
            label="Refresh list"
            hint="Read the servers from omp again"
            actionLabel={refresh.isPending ? "Refreshing..." : "Refresh"}
            disabled={refresh.isPending}
            onPress={() => refresh.mutate()}
          />
        </SettingsCard>
      </SettingsSection>
      {mcps.isLoading ? <Text style={styles.muted}>Loading MCP servers...</Text> : null}
      {notice ? <Text style={styles.error}>{notice}</Text> : null}
      {view && !view.installed ? (
        <Text style={styles.muted}>The omp command was not found on this host</Text>
      ) : null}
      {view?.installed && !view.error && view.servers.length === 0 ? (
        <Text style={styles.muted}>No MCP servers yet</Text>
      ) : null}
      {view?.servers.map((server) => (
        <ServerSection
          key={`${server.source}/${server.name}`}
          styles={styles}
          server={server}
          outcome={outcomes.get(server.name)}
          busy={run.isPending}
          testing={
            run.isPending && run.variables?.name === server.name && run.variables.action === "test"
          }
          authorizing={authorize.isPending && authorize.variables === server.name}
          onToggle={(enabled) =>
            run.mutate({ name: server.name, action: enabled ? "enable" : "disable" })
          }
          onTest={() => run.mutate({ name: server.name, action: "test" })}
          onAuthorize={() => authorize.mutate(server.name)}
          onRemove={() => setPendingRemove(server.name)}
        />
      ))}
      {adding ? (
        <AddMcpModal
          busy={add.isPending}
          error={addError}
          onAdd={(input) => add.mutate(input)}
          onEdit={() => add.reset()}
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
    </View>
  );
}
