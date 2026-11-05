import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import {
  listOmpRuleFirings,
  listOmpRules,
  type OmpRule,
  type OmpRuleFiring,
  type OmpRuleKind,
  setOmpRuleEnabled,
} from "../shared/omp-rules";
import type { OmpStore } from "../shared/omp-store";
import { describe } from "./omp-accounts-section";
import type { OmpConfigStyles } from "./omp-config-styles";
import { OmpRuleTest } from "./omp-rule-test";
import { ompStoreKey } from "./omp-store-state";

type Theme = PluginSurfaceProps["theme"];
type CopyState = "idle" | "copied" | "failed";

const COPY_LABELS: Record<CopyState, string> = {
  idle: "Copy path",
  copied: "Copied",
  failed: "Copy failed",
};

const RULES_KEY = ["paseo-omp", "rules"] as const;
const FIRINGS_KEY = ["paseo-omp", "rule-firings"] as const;
const MOST_FIRED = 3;

function firingText(firing: OmpRuleFiring): string {
  const times = firing.count === 1 ? "1 time" : `${firing.count} times`;
  return firing.lastFiredAt
    ? `${times}, last ${new Date(firing.lastFiredAt).toLocaleString()}`
    : times;
}

function firedSummary(counted: {
  firings: readonly OmpRuleFiring[];
  sessions: number;
  partial: boolean;
}): string {
  const top = counted.firings
    .slice(0, MOST_FIRED)
    .map((firing) => `${firing.name} (${firing.count})`)
    .join(", ");
  const sessions = `${counted.sessions} ${counted.sessions === 1 ? "session" : "sessions"}`;
  const bound = counted.partial ? ", so some firings are not counted" : "";
  return top
    ? `Most fired: ${top}. Counted by rule name from ${sessions}${bound}.`
    : `No rule fired in the ${sessions} counted${bound}.`;
}

const GROUPS: readonly { kind: OmpRuleKind; title: string; empty: string }[] = [
  { kind: "watch", title: "Watch", empty: "No watch rules" },
  { kind: "always", title: "Always applied", empty: "No always-applied rules" },
  { kind: "rulebook", title: "Rulebook", empty: "No rulebook rules" },
];

function sourceLabel(rule: OmpRule): string {
  if (rule.source === "project") return "Project";
  if (rule.source === "user") return "User";
  if (rule.source === "builtin") return "Built-in";
  if (rule.provider === "omp-plugins") return "From an OMP plugin";
  return `Imported from ${rule.provider}`;
}

function Detail({
  styles,
  label,
  value,
}: {
  styles: OmpConfigStyles;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.recordRow}>
      <Text style={styles.recordKey}>{label}</Text>
      <Text selectable style={styles.recordValue}>
        {value}
      </Text>
    </View>
  );
}

interface RuleSwitch {
  busy: boolean;
  toggle: (name: string, enabled: boolean) => void;
  /** How often the rule fired in the counted sessions; null until they are counted. */
  firingLabel: (name: string) => string | null;
}

function RuleRow({
  styles,
  rule,
  rules,
}: {
  styles: OmpConfigStyles;
  rule: OmpRule;
  rules: RuleSwitch;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  async function copyPath() {
    try {
      await copyText(rule.path);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  const details: [string, string[]][] = [
    ["Text matches", rule.condition],
    ["Code matches", rule.astCondition],
    ["Asks the judge", rule.question ? [rule.question] : []],
    ["Watches", rule.scope],
    ["Files", rule.globs],
    ["Agents", rule.agents],
  ];
  // Only watch rules fire; always-applied and rulebook rules sit in the prompt.
  const fired = rule.kind === "watch" ? rules.firingLabel(rule.name) : null;
  return (
    <View style={styles.setting}>
      <View style={styles.settingHeader}>
        <Text selectable style={styles.settingValue}>
          {rule.name}
        </Text>
        <Text style={styles.source}>{sourceLabel(rule)}</Text>
        <Switch
          accessibilityLabel={`Rule ${rule.name} is on`}
          disabled={rules.busy}
          value
          onValueChange={() => rules.toggle(rule.name, false)}
        />
      </View>
      {rule.description ? <Text style={styles.settingDescription}>{rule.description}</Text> : null}
      {fired ? <Detail styles={styles} label="Fired" value={fired} /> : null}
      {details.map(([label, values]) =>
        values.length > 0 ? (
          <Detail key={label} styles={styles} label={label} value={values.join(", ")} />
        ) : null,
      )}
      <View style={styles.settingHeader}>
        <Text selectable style={styles.settingPath}>
          {rule.path}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy the path of rule ${rule.name}`}
          onPress={copyPath}
        >
          <Text style={styles.resetAction}>{COPY_LABELS[copyState]}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function BuiltinRules({
  theme,
  styles,
  rules,
  rulesSwitch,
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  rules: OmpRule[];
  rulesSwitch: RuleSwitch;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rules.length === 0) return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? "Hide" : "Show"} ${rules.length} built-in rules`}
        onPress={() => setExpanded(!expanded)}
        style={[styles.setting, styles.sectionHeaderRow]}
      >
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text style={styles.rowValue}>Built-in rules ({rules.length})</Text>
      </Pressable>
      {expanded
        ? rules.map((rule) => (
            <RuleRow key={rule.name} styles={styles} rule={rule} rules={rulesSwitch} />
          ))
        : null}
    </>
  );
}

export function OmpRulesSection({
  theme,
  styles,
  cwd,
  store,
  focusRule,
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  cwd?: string;
  store?: OmpStore;
  /** The rule a "fired" link opened this tab for, shown first. */
  focusRule?: string;
}) {
  const loadRules = useRpc(listOmpRules);
  const setEnabled = useRpc(setOmpRuleEnabled);
  const toast = useToast();
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: [...RULES_KEY, ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadRules({ store, ...(cwd ? { cwd } : {}) }),
  });
  const loadFirings = useRpc(listOmpRuleFirings);
  const firingsQuery = useQuery({
    queryKey: [...FIRINGS_KEY, ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadFirings({ store, ...(cwd ? { cwd } : {}) }),
    staleTime: 30_000,
  });
  const counted = firingsQuery.data;
  const firingByName = new Map((counted?.firings ?? []).map((firing) => [firing.name, firing]));
  function firingLabel(name: string): string | null {
    const firing = firingByName.get(name);
    if (firing) return firingText(firing);
    return counted && !counted.partial ? "Not fired in the sessions counted" : null;
  }
  function noisiestFirst(left: OmpRule, right: OmpRule): number {
    return (firingByName.get(right.name)?.count ?? 0) - (firingByName.get(left.name)?.count ?? 0);
  }
  const toggle = useMutation({
    mutationKey: [...RULES_KEY, "toggle"],
    mutationFn: (change: { name: string; enabled: boolean }) =>
      setEnabled({ store, ...(cwd ? { cwd } : {}), ...change }),
    onSuccess: async (result) => {
      if (result.status === "error") toast.error(result.message);
      await queryClient.invalidateQueries({ queryKey: RULES_KEY });
    },
    onError: (error) => toast.error(describe(error)),
  });
  const rulesSwitch: RuleSwitch = {
    busy: toggle.isPending,
    toggle: (name, enabled) => toggle.mutate({ name, enabled }),
    firingLabel,
  };
  const list = rules.data;
  const focused =
    list?.status === "ready" ? list.rules.find((rule) => rule.name === focusRule) : undefined;
  const focusNote =
    list?.status === "ready" && list.disabled.includes(focusRule ?? "")
      ? "This rule is turned off. Switch it on under Turned off below."
      : "No rule with this name is in this scope.";
  return (
    <>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Rules</Text>
        <Text style={styles.muted}>
          Watch rules step in when the agent writes something they match. Always-applied rules are
          part of every prompt. Rulebook rules are listed by name and read when relevant. Changes
          apply to new sessions, or after an agent reload.
        </Text>
        <Text style={styles.muted}>
          Rules imported from other tools, such as Cursor or Windsurf, appear here only when they
          are watch rules.
        </Text>
        <Text style={styles.muted}>Rule settings (ttsr.*) are in the Configuration tab.</Text>
      </View>
      {counted ? <Text style={styles.muted}>{firedSummary(counted)}</Text> : null}
      {focusRule && list?.status === "ready" ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Rule named {focusRule}</Text>
          <Text style={styles.muted}>
            Matched by name in this scope. If the rule that fired came from a project's .omp folder,
            look in that workspace's OMP tab.
          </Text>
          {focused ? (
            <RuleRow styles={styles} rule={focused} rules={rulesSwitch} />
          ) : (
            <Text style={styles.muted}>{focusNote}</Text>
          )}
        </View>
      ) : null}
      <OmpRuleTest theme={theme} styles={styles} cwd={cwd} store={store} />
      {rules.isLoading ? <Text style={styles.muted}>Loading rules...</Text> : null}
      {rules.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not list OMP's rules.
        </Text>
      ) : null}
      {list?.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {list.message}
        </Text>
      ) : null}
      {list?.status === "ready" ? (
        <>
          {GROUPS.map((group) => {
            const members = list.rules.filter((rule) => rule.kind === group.kind);
            const own = members.filter((rule) => rule.source !== "builtin").sort(noisiestFirst);
            const builtin = members.filter((rule) => rule.source === "builtin").sort(noisiestFirst);
            return (
              <View key={group.kind} style={styles.card}>
                <Text style={styles.cardTitle}>{group.title}</Text>
                {members.length === 0 ? <Text style={styles.muted}>{group.empty}</Text> : null}
                {own.map((rule) => (
                  <RuleRow key={rule.name} styles={styles} rule={rule} rules={rulesSwitch} />
                ))}
                <BuiltinRules
                  theme={theme}
                  styles={styles}
                  rules={builtin}
                  rulesSwitch={rulesSwitch}
                />
                {group.kind === "watch" && !list.builtinRules ? (
                  <Text style={styles.muted}>Built-in rules are off (ttsr.builtinRules)</Text>
                ) : null}
              </View>
            );
          })}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Turned off</Text>
            {list.disabled.length === 0 ? (
              <Text style={styles.muted}>No rules turned off</Text>
            ) : (
              <>
                <Text style={styles.muted}>Listed in ttsr.disabledRules, so OMP skips them</Text>
                {list.disabled.map((name) => (
                  <View key={name} style={[styles.setting, styles.settingHeader]}>
                    <Text selectable style={styles.settingValue}>
                      {name}
                    </Text>
                    <Switch
                      accessibilityLabel={`Rule ${name} is off`}
                      disabled={rulesSwitch.busy}
                      value={false}
                      onValueChange={() => rulesSwitch.toggle(name, true)}
                    />
                  </View>
                ))}
              </>
            )}
          </View>
        </>
      ) : null}
    </>
  );
}
