import { TextInput } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type OmpBashRule,
  OmpBashRuleSchema,
  OmpRestrictedFoldersSchema,
  type OmpSetting,
  type OmpToolApproval,
} from "../shared/omp-settings";
import type { OmpConfigStyles } from "./omp-config-styles";
import {
  canAddBashRule,
  canAddToolRule,
  moveRule,
  policyWarnings,
  readBashRuleDraft,
  readBashRules,
  readFolders,
  readToolPolicies,
} from "./omp-tool-policy-state";

type PolicyDraft = { operation: "set"; value: unknown } | { operation: "reset" };

const APPROVALS: readonly { value: OmpToolApproval; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "prompt", label: "Ask" },
  { value: "deny", label: "Deny" },
];

const CAVEATS = [
  "Deny, Ask and restricted-folder rules also apply in Full Access.",
  "A new Deny rule may not guard an agent that is already running until it is reloaded.",
  "Bash rules do not cover commands run through eval, are not a sandbox, and only support * wildcards. The first matching rule wins.",
];

interface ToolPolicyCardProps {
  settings: readonly OmpSetting[];
  visiblePaths: readonly string[];
  drafts: Readonly<Record<string, PolicyDraft>>;
  disabled: boolean;
  workspaceScoped: boolean;
  resetLabel: string;
  styles: OmpConfigStyles;
  onSet(path: string, value: unknown): void;
  onReset(path: string): void;
}

const ACTION_GROUP = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;

function Action({
  label,
  text,
  disabled,
  selected,
  styles,
  onPress,
}: {
  label: string;
  text: string;
  disabled: boolean;
  selected?: boolean;
  styles: OmpConfigStyles;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: selected === true }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.editorAction, selected ? styles.editorActionPrimary : null]}
    >
      <Text style={[styles.editorActionText, selected ? styles.editorActionTextPrimary : null]}>
        {text}
      </Text>
    </Pressable>
  );
}

function ApprovalChoice({
  subject,
  value,
  disabled,
  styles,
  onChange,
}: {
  subject: string;
  value: OmpToolApproval;
  disabled: boolean;
  styles: OmpConfigStyles;
  onChange(value: OmpToolApproval): void;
}) {
  return (
    <>
      {APPROVALS.map((choice) => (
        <Action
          key={choice.value}
          label={`${choice.label} ${subject}`}
          text={choice.label}
          disabled={disabled}
          selected={value === choice.value}
          styles={styles}
          onPress={() => onChange(choice.value)}
        />
      ))}
    </>
  );
}

function PolicySection({
  title,
  description,
  pending,
  showReset,
  resetLabel,
  disabled,
  styles,
  onReset,
  children,
}: {
  title: string;
  description: string;
  pending: boolean;
  showReset: boolean;
  resetLabel: string;
  disabled: boolean;
  styles: OmpConfigStyles;
  onReset(): void;
  children: ReactNode;
}) {
  return (
    <View style={styles.setting}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.settingDescription}>{description}</Text>
      {pending ? (
        <Text style={styles.muted}>{resetLabel} when changes are applied</Text>
      ) : (
        <View style={styles.recordList}>{children}</View>
      )}
      {showReset ? (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onReset}>
          <Text style={styles.resetAction}>{resetLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function AddRow({
  label,
  inputLabel,
  placeholder,
  valid,
  disabled,
  styles,
  onAdd,
}: {
  label: string;
  inputLabel: string;
  placeholder: string;
  valid(text: string): boolean;
  disabled: boolean;
  styles: OmpConfigStyles;
  onAdd(text: string): void;
}) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  return (
    <View style={styles.recordRow}>
      <TextInput
        accessibilityLabel={inputLabel}
        editable={!disabled}
        placeholder={placeholder}
        value={text}
        onChangeText={setText}
        style={styles.scalarInput}
      />
      <Action
        label={label}
        text="Add"
        disabled={disabled || !valid(trimmed)}
        styles={styles}
        onPress={() => {
          onAdd(trimmed);
          setText("");
        }}
      />
    </View>
  );
}

/** Rules have no identity of their own and their order is the data, so each row carries an id that follows it through moves and removals. */
function useRuleIds(length: number) {
  const ids = useRef<number[]>([]);
  const nextId = useRef(0);
  while (ids.current.length < length) ids.current.push(nextId.current++);
  ids.current.length = length;
  return ids;
}

export function ToolPolicyCard({
  settings,
  visiblePaths,
  drafts,
  disabled,
  workspaceScoped,
  resetLabel,
  styles,
  onSet,
  onReset,
}: ToolPolicyCardProps) {
  const byPath = new Map(settings.map((setting) => [setting.path, setting]));
  const current = (path: string): unknown => {
    const draft = drafts[path];
    return draft?.operation === "set" ? draft.value : byPath.get(path)?.value;
  };
  const resetting = (path: string) => drafts[path]?.operation === "reset";
  const canReset = (path: string) =>
    !workspaceScoped || byPath.get(path)?.workspaceOverride === true;
  const inheritedPolicies = readToolPolicies(
    workspaceScoped ? byPath.get("tools.approval")?.userValue : undefined,
  );
  const policies = readToolPolicies(current("tools.approval"));
  const bashDraft = drafts["bash.patterns"];
  const rules =
    bashDraft?.operation === "set"
      ? readBashRuleDraft(bashDraft.value)
      : readBashRules(byPath.get("bash.patterns")?.value);
  const folders = readFolders(current("tools.restrictedFolders"));
  const ruleIds = useRuleIds(rules.length);
  const warnings = policyWarnings({ policies, rules });
  const setRule = (index: number, rule: OmpBashRule) =>
    onSet(
      "bash.patterns",
      rules.map((existing, position) => (position === index ? rule : existing)),
    );

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Tool policy</Text>
      </View>
      {visiblePaths.includes("tools.approval") ? (
        <PolicySection
          title="Per-tool approval"
          description="Allow runs a tool without asking, Ask requires confirmation and Deny blocks it. These rules win over the approval mode."
          pending={resetting("tools.approval")}
          showReset={canReset("tools.approval")}
          resetLabel={resetLabel}
          disabled={disabled}
          styles={styles}
          onReset={() => onReset("tools.approval")}
        >
          {Object.entries(policies).map(([tool, approval]) => (
            <View key={tool} style={styles.recordRow}>
              <Text selectable style={styles.recordKey}>
                {tool}
              </Text>
              <View style={ACTION_GROUP}>
                <ApprovalChoice
                  subject={tool}
                  value={approval}
                  disabled={disabled}
                  styles={styles}
                  onChange={(next) => onSet("tools.approval", { ...policies, [tool]: next })}
                />
                {inheritedPolicies[tool] === approval ? (
                  <Text style={styles.muted}>From user config</Text>
                ) : (
                  <Action
                    label={`Remove ${tool}`}
                    text="Remove"
                    disabled={disabled}
                    styles={styles}
                    onPress={() =>
                      onSet(
                        "tools.approval",
                        Object.fromEntries(
                          Object.entries(policies).filter(([name]) => name !== tool),
                        ),
                      )
                    }
                  />
                )}
              </View>
            </View>
          ))}
          <AddRow
            label="Add tool rule"
            inputLabel="Tool name"
            placeholder="Tool, e.g. eval"
            valid={(text) => canAddToolRule(policies, text)}
            disabled={disabled}
            styles={styles}
            onAdd={(tool) => onSet("tools.approval", { ...policies, [tool]: "prompt" })}
          />
        </PolicySection>
      ) : null}
      {visiblePaths.includes("bash.patterns") ? (
        <PolicySection
          title="Bash command rules"
          description="Matched top to bottom against each bash command; the first match decides. Use * as a wildcard, for example npm test* or git push --force*."
          pending={resetting("bash.patterns")}
          showReset={canReset("bash.patterns")}
          resetLabel={resetLabel}
          disabled={disabled}
          styles={styles}
          onReset={() => onReset("bash.patterns")}
        >
          {rules.map((rule, index) => (
            <View key={ruleIds.current[index]} style={styles.recordRow}>
              <Text style={styles.recordKey}>{index + 1}</Text>
              <TextInput
                accessibilityLabel={`Bash rule ${index + 1} pattern`}
                editable={!disabled}
                value={rule.match}
                onChangeText={(match) => setRule(index, { ...rule, match })}
                style={styles.scalarInput}
              />
              {OmpBashRuleSchema.safeParse(rule).success ? null : (
                <Text style={styles.error}>Enter a pattern of 1 to 512 characters.</Text>
              )}
              <View style={ACTION_GROUP}>
                <ApprovalChoice
                  subject={`for bash rule ${index + 1}`}
                  value={rule.approval}
                  disabled={disabled}
                  styles={styles}
                  onChange={(approval) => setRule(index, { ...rule, approval })}
                />
                <Action
                  label={`Move bash rule ${index + 1} up`}
                  text="Up"
                  disabled={disabled || index === 0}
                  styles={styles}
                  onPress={() => {
                    ruleIds.current = moveRule(ruleIds.current, index, -1);
                    onSet("bash.patterns", moveRule(rules, index, -1));
                  }}
                />
                <Action
                  label={`Move bash rule ${index + 1} down`}
                  text="Down"
                  disabled={disabled || index === rules.length - 1}
                  styles={styles}
                  onPress={() => {
                    ruleIds.current = moveRule(ruleIds.current, index, 1);
                    onSet("bash.patterns", moveRule(rules, index, 1));
                  }}
                />
                <Action
                  label={`Remove bash rule ${index + 1}`}
                  text="Remove"
                  disabled={disabled}
                  styles={styles}
                  onPress={() => {
                    ruleIds.current = ruleIds.current.filter((_, position) => position !== index);
                    onSet(
                      "bash.patterns",
                      rules.filter((_, position) => position !== index),
                    );
                  }}
                />
              </View>
            </View>
          ))}
          <AddRow
            label="Add bash rule"
            inputLabel="Bash command pattern"
            placeholder="Pattern, e.g. npm test*"
            valid={(text) => canAddBashRule(rules, text)}
            disabled={disabled}
            styles={styles}
            onAdd={(match) => onSet("bash.patterns", [...rules, { match, approval: "prompt" }])}
          />
        </PolicySection>
      ) : null}
      {visiblePaths.includes("tools.restrictedFolders") ? (
        <PolicySection
          title="Restricted folders"
          description="Every read, write, edit, search or command in these folders, and everything under them, needs an explicit approval in every mode."
          pending={resetting("tools.restrictedFolders")}
          showReset={canReset("tools.restrictedFolders")}
          resetLabel={resetLabel}
          disabled={disabled}
          styles={styles}
          onReset={() => onReset("tools.restrictedFolders")}
        >
          {folders.map((folder, index) => (
            <View key={folder} style={styles.recordRow}>
              <Text selectable style={styles.recordValue}>
                {folder}
              </Text>
              <Action
                label={`Remove ${folder}`}
                text="Remove"
                disabled={disabled}
                styles={styles}
                onPress={() =>
                  onSet(
                    "tools.restrictedFolders",
                    folders.filter((_, position) => position !== index),
                  )
                }
              />
            </View>
          ))}
          <AddRow
            label="Add restricted folder"
            inputLabel="Restricted folder path"
            placeholder="Path, e.g. ~/secrets"
            valid={(text) => OmpRestrictedFoldersSchema.safeParse([...folders, text]).success}
            disabled={disabled}
            styles={styles}
            onAdd={(folder) => onSet("tools.restrictedFolders", [...folders, folder])}
          />
        </PolicySection>
      ) : null}
      <View style={styles.setting}>
        {warnings.map((warning) => (
          <Text key={warning} style={styles.error}>
            {warning}
          </Text>
        ))}
        {CAVEATS.map((caveat) => (
          <Text key={caveat} style={styles.settingDescription}>
            {caveat}
          </Text>
        ))}
      </View>
    </View>
  );
}
