import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  listOmpExtensions,
  type OmpExtensionItem,
  type OmpExtensionKind,
  setOmpExtensionEnabled,
} from "../shared/omp-extensions";
import type { OmpStore } from "../shared/omp-store";
import { ConfirmModal, describe } from "./omp-accounts-section";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";

type Theme = PluginSurfaceProps["theme"];

const EXTENSIONS_KEY = ["paseo-omp", "extensions"] as const;

const GROUPS: readonly { kind: OmpExtensionKind; title: string }[] = [
  { kind: "extension", title: "Extensions" },
  { kind: "hook", title: "Hooks" },
  { kind: "tool", title: "Custom tools" },
];

const INFO =
  "Read from the folders OMP documents: the workspace's .omp/ and OMP's agent directory. OMP has no list command, so this is a close inventory: it does not read .gitignore, package.json manifests or the extensions setting, and it never follows symlinks. Turning one off adds it to disabledExtensions; in a workspace the whole list is saved to the project's .omp/config.yml, because a project list replaces the user list. Changes apply to new sessions. OMP does not report extension load errors for the built-in omp agents.";

const RESTART_HINT = "Turned on. An agent that is already running needs a restart to load it.";

/** Extensions and hooks can block or rewrite tool calls; a tool only adds one. */
function needsWarning(item: OmpExtensionItem): boolean {
  return item.kind !== "tool";
}

function itemHint(item: OmpExtensionItem): string {
  const level = item.level === "project" ? "Project" : "User";
  return `${level} · ${item.path}`;
}

export function OmpExtensionsSection({
  theme,
  styles,
  cwd,
  store,
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  cwd?: string;
  store?: OmpStore;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const load = useRpc(listOmpExtensions);
  const setEnabled = useRpc(setOmpExtensionEnabled);
  const [pendingOff, setPendingOff] = useState<OmpExtensionItem | null>(null);
  const scope = cwd ? { cwd } : {};
  const extensions = useQuery({
    queryKey: [...EXTENSIONS_KEY, ompStoreKey(store), cwd ?? "global"],
    queryFn: () => load({ store, ...scope }),
  });
  const toggle = useMutation({
    mutationKey: [...EXTENSIONS_KEY, "toggle"],
    mutationFn: (change: { id: string; enabled: boolean }) =>
      setEnabled({ store, ...scope, ...change }),
    onSuccess: async (result, change) => {
      if (result.status === "error") toast.error(result.message);
      else if (change.enabled) toast.show(RESTART_HINT, { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: EXTENSIONS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
    onSettled: () => setPendingOff(null),
  });

  function flip(item: OmpExtensionItem) {
    if (item.enabled && needsWarning(item)) setPendingOff(item);
    else toggle.mutate({ id: item.id, enabled: !item.enabled });
  }

  const list = extensions.data;
  return (
    <View style={{ gap: 12 }}>
      <SettingsSection title="Extensions, hooks and tools" info={INFO}>
        <Text style={styles.muted}>
          Code OMP runs for this {cwd ? "workspace" : "user"}. Turned-off items stay listed.
        </Text>
      </SettingsSection>
      {extensions.isLoading ? <Text style={styles.muted}>Loading extensions...</Text> : null}
      {extensions.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not list OMP's extensions.
        </Text>
      ) : null}
      {list?.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {list.message}
        </Text>
      ) : null}
      {list?.status === "ready" && list.items.length === 0 ? (
        <Text style={styles.muted}>No extensions, hooks or custom tools found</Text>
      ) : null}
      {list?.status === "ready"
        ? GROUPS.map((group) => {
            const members = list.items.filter((item) => item.kind === group.kind);
            if (members.length === 0) return null;
            return (
              <SettingsSection key={group.kind} title={group.title}>
                <SettingsCard>
                  {members.map((item) => (
                    <SettingsSwitch
                      key={`${item.level}/${item.id}`}
                      label={item.name}
                      hint={itemHint(item)}
                      value={item.enabled}
                      disabled={toggle.isPending}
                      onValueChange={() => flip(item)}
                    />
                  ))}
                </SettingsCard>
              </SettingsSection>
            );
          })
        : null}
      {pendingOff ? (
        <ConfirmModal
          styles={styles}
          theme={theme}
          title={`Turn off ${pendingOff.name}?`}
          body="It may be guarding or rewriting tool calls, such as a safety hook. Turning it off removes that protection for new sessions, for the terminal too."
          confirmLabel="Turn off"
          tone="danger"
          busy={toggle.isPending}
          onConfirm={() => toggle.mutate({ id: pendingOff.id, enabled: false })}
          onCancel={() => setPendingOff(null)}
        />
      ) : null}
    </View>
  );
}
