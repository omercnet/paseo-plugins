import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listOmpRules, type OmpRule, type OmpRuleKind } from "../shared/omp-rules";
import type { OmpStore } from "../shared/omp-store";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";

type Theme = PluginSurfaceProps["theme"];
type CopyState = "idle" | "copied" | "failed";

const COPY_LABELS: Record<CopyState, string> = {
  idle: "Copy path",
  copied: "Copied",
  failed: "Copy failed",
};

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

function RuleRow({ styles, rule }: { styles: OmpConfigStyles; rule: OmpRule }) {
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
  return (
    <View style={styles.setting}>
      <View style={styles.settingHeader}>
        <Text selectable style={styles.settingValue}>
          {rule.name}
        </Text>
        <Text style={styles.source}>{sourceLabel(rule)}</Text>
      </View>
      {rule.description ? <Text style={styles.settingDescription}>{rule.description}</Text> : null}
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
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  rules: OmpRule[];
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
        ? rules.map((rule) => <RuleRow key={rule.name} styles={styles} rule={rule} />)
        : null}
    </>
  );
}

export function OmpRulesSection({
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
  const loadRules = useRpc(listOmpRules);
  const rules = useQuery({
    queryKey: ["paseo-omp", "rules", ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadRules({ store, ...(cwd ? { cwd } : {}) }),
  });
  const list = rules.data;
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
            const own = members.filter((rule) => rule.source !== "builtin");
            const builtin = members.filter((rule) => rule.source === "builtin");
            return (
              <View key={group.kind} style={styles.card}>
                <Text style={styles.cardTitle}>{group.title}</Text>
                {members.length === 0 ? <Text style={styles.muted}>{group.empty}</Text> : null}
                {own.map((rule) => (
                  <RuleRow key={rule.name} styles={styles} rule={rule} />
                ))}
                <BuiltinRules theme={theme} styles={styles} rules={builtin} />
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
                  <View key={name} style={styles.setting}>
                    <Text selectable style={styles.settingValue}>
                      {name}
                    </Text>
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
