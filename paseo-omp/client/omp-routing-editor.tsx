import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import type { OmpAgent } from "../shared/omp-agents";
import {
  formatOmpSettingLabel,
  isOmpStructuredSettingPath,
  type OmpSetting,
  parseOmpStructuredSettingValue,
} from "../shared/omp-settings";
import type { OmpConfigStyles } from "./omp-config-styles";
import { OmpModelPicker } from "./omp-model-picker";
import {
  aliasChoices,
  type OmpModelPickerModel,
  updatePickerValue,
} from "./omp-model-picker-state";

type RoutingRecord = Record<string, unknown>;

export type OmpModelCatalogState = {
  models: readonly OmpModelPickerModel[];
  loading: boolean;
  error?: string;
};

type StructuredRoutingEditorProps = {
  setting: OmpSetting;
  value: unknown;
  disabled: boolean;
  resetLabel: string;
  showReset: boolean;
  resetPending: boolean;
  styles: OmpConfigStyles;
  theme: PluginSurfaceProps["theme"];
  modelCatalog: OmpModelCatalogState;
  modelRoles: Readonly<Record<string, unknown>>;
  agents: readonly OmpAgent[];
  onSet(value: unknown): void;
  onReset(): void;
};

function asRecord(value: unknown): RoutingRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RoutingRecord)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")) : [];
}

function replaceRecordKey(record: RoutingRecord, oldKey: string, newKey: string): RoutingRecord {
  const next: RoutingRecord = {};
  for (const [key, value] of Object.entries(record)) next[key === oldKey ? newKey : key] = value;
  return next;
}

function removeRecordKey(record: RoutingRecord, removedKey: string): RoutingRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== removedKey));
}

function nextRecordKey(record: RoutingRecord, prefix: string): string {
  let suffix = 1;
  while (Object.hasOwn(record, `${prefix}${suffix}`)) suffix += 1;
  return `${prefix}${suffix}`;
}

function RowButton({
  label,
  disabled,
  styles,
  onPress,
}: {
  label: string;
  disabled: boolean;
  styles: OmpConfigStyles;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={styles.editorAction}
    >
      <Text style={styles.editorActionText}>{label}</Text>
    </Pressable>
  );
}

function OrderedRoleEditor({
  value,
  disabled,
  styles,
  onSet,
}: Pick<StructuredRoutingEditorProps, "value" | "disabled" | "styles" | "onSet">) {
  const roles = asStringArray(value);
  return (
    <View style={styles.recordList}>
      {roles.map((role, index) => (
        <View key={index} style={styles.recordRow}>
          <Text style={styles.recordKey}>{index + 1}</Text>
          <TextInput
            accessibilityLabel={`Cycle role ${index + 1}`}
            editable={!disabled}
            value={role}
            onChangeText={(nextRole) =>
              onSet(roles.map((current, position) => (position === index ? nextRole : current)))
            }
            style={styles.scalarInput}
          />
          <RowButton
            label={`Remove cycle role ${index + 1}`}
            disabled={disabled}
            styles={styles}
            onPress={() => onSet(roles.filter((_, position) => position !== index))}
          />
        </View>
      ))}
      <RowButton
        label="Add cycle role"
        disabled={disabled}
        styles={styles}
        onPress={() => onSet([...roles, ""])}
      />
    </View>
  );
}

function AgentPicker({
  agents,
  taken,
  disabled,
  styles,
  onSelect,
}: {
  agents: readonly OmpAgent[];
  taken: readonly string[];
  disabled: boolean;
  styles: OmpConfigStyles;
  onSelect(name: string): void;
}) {
  const [open, setOpen] = useState(false);
  const choices = agents.filter((agent) => !taken.includes(agent.name));
  if (choices.length === 0) return null;
  return (
    <View style={styles.recordList}>
      <RowButton
        label={open ? "Close agents" : "Choose agent"}
        disabled={disabled}
        styles={styles}
        onPress={() => setOpen((current) => !current)}
      />
      {open
        ? choices.map((agent) => (
            <RowButton
              key={agent.name}
              label={`${agent.name} (${agent.source})`}
              disabled={disabled}
              styles={styles}
              onPress={() => {
                onSelect(agent.name);
                setOpen(false);
              }}
            />
          ))
        : null}
    </View>
  );
}

/** Turning off the default agent fails every task call that names no agent. */
const DEFAULT_AGENT = "task";

function DisabledAgentsEditor({
  value,
  agents,
  disabled,
  styles,
  onSet,
}: Pick<StructuredRoutingEditorProps, "value" | "agents" | "disabled" | "styles" | "onSet">) {
  const switchedOff = asStringArray(value);
  const listed = agents.map((agent) => agent.name);
  const names = [...listed, ...switchedOff.filter((name) => !listed.includes(name))];
  if (names.length === 0) return <Text style={styles.muted}>No agents found.</Text>;
  return (
    <View style={styles.recordList}>
      {names.map((name) => {
        const off = switchedOff.includes(name);
        const locked = name === DEFAULT_AGENT && !off;
        return (
          <View key={name} style={styles.recordRow}>
            <Text style={styles.recordKey}>{name}</Text>
            <Switch
              accessibilityLabel={`Agent ${name} is ${off ? "off" : "on"}`}
              value={!off}
              disabled={disabled || locked}
              onValueChange={(on) =>
                onSet(on ? switchedOff.filter((item) => item !== name) : [...switchedOff, name])
              }
            />
            {locked ? (
              <Text style={styles.muted}>
                The default agent stays on: without it every task call that names no agent fails.
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function RecordRoutingEditor({
  setting,
  value,
  disabled,
  styles,
  theme,
  modelCatalog,
  modelRoles,
  agents,
  onSet,
}: Pick<
  StructuredRoutingEditorProps,
  | "setting"
  | "value"
  | "disabled"
  | "styles"
  | "onSet"
  | "theme"
  | "modelCatalog"
  | "modelRoles"
  | "agents"
>) {
  const record = asRecord(value);
  const [keyErrors, setKeyErrors] = useState<Record<string, string>>({});
  const entries = Object.entries(record);
  const fallbackChains = setting.path === "retry.fallbackChains";
  const agentModels = setting.path === "task.agentModelOverrides";
  const keyLabel = setting.path.startsWith("task.")
    ? "Agent"
    : fallbackChains
      ? "Role or model"
      : "Role";
  const valueLabel = fallbackChains
    ? "Fallback selectors, comma separated"
    : agentModels
      ? "Model selectors, comma separated"
      : setting.path === "task.agentServiceTierOverrides"
        ? "Service tier"
        : setting.path === "task.agentPrewalk" || setting.path === "task.agentAdvisor"
          ? "on, off, or model selector"
          : "Model selector";
  const supportsModelPicker = setting.path !== "task.agentServiceTierOverrides";

  return (
    <View style={styles.recordList}>
      {entries.map(([key, rawValue], index) => {
        const textValue = Array.isArray(rawValue)
          ? rawValue.filter((item): item is string => typeof item === "string").join(", ")
          : typeof rawValue === "string"
            ? rawValue
            : "";
        return (
          <View key={index} style={styles.recordRow}>
            <TextInput
              accessibilityLabel={`${formatOmpSettingLabel(setting.path)} ${keyLabel} ${index + 1}`}
              editable={!disabled}
              value={key}
              onChangeText={(newKey) => {
                if (newKey !== key && Object.hasOwn(record, newKey)) {
                  setKeyErrors((current) => ({
                    ...current,
                    [key]: `Another entry already uses ${newKey}.`,
                  }));
                  return;
                }
                setKeyErrors((current) => {
                  const next = { ...current };
                  delete next[key];
                  delete next[newKey];
                  return next;
                });
                onSet(replaceRecordKey(record, key, newKey));
              }}
              style={styles.scalarInput}
            />
            {keyErrors[key] ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {keyErrors[key]}
              </Text>
            ) : null}
            {setting.path.startsWith("task.") ? (
              <AgentPicker
                agents={agents}
                taken={Object.keys(record)}
                disabled={disabled}
                styles={styles}
                onSelect={(name) => onSet(replaceRecordKey(record, key, name))}
              />
            ) : null}
            <TextInput
              accessibilityLabel={`${formatOmpSettingLabel(setting.path)} ${valueLabel} ${index + 1}`}
              editable={!disabled}
              value={textValue}
              onChangeText={(newValue) => {
                const next = { ...record };
                if (fallbackChains || agentModels) {
                  const selectors = newValue
                    .split(",")
                    .map((selector) => selector.trim())
                    .filter(Boolean);
                  next[key] = agentModels && selectors.length === 1 ? selectors[0] : selectors;
                } else {
                  next[key] = newValue;
                }
                onSet(next);
              }}
              style={styles.scalarInput}
            />
            {supportsModelPicker ? (
              <OmpModelPicker
                theme={theme}
                models={modelCatalog.models}
                aliases={
                  setting.path === "modelRoles"
                    ? []
                    : aliasChoices(modelRoles, fallbackChains ? key : undefined)
                }
                role={
                  setting.path === "task.agentAdvisor"
                    ? "advisor"
                    : setting.path === "task.agentPrewalk"
                      ? ""
                      : key.replace(/^@/u, "")
                }
                disabled={disabled}
                loading={modelCatalog.loading}
                error={modelCatalog.error}
                onSelect={(selector) => {
                  const next = { ...record };
                  if (fallbackChains || agentModels) {
                    next[key] = updatePickerValue(
                      Array.isArray(rawValue)
                        ? rawValue.filter((item): item is string => typeof item === "string")
                        : typeof rawValue === "string"
                          ? rawValue
                          : [],
                      selector,
                      "append",
                    );
                  } else {
                    next[key] = updatePickerValue(textValue, selector, "replace");
                  }
                  onSet(next);
                }}
              />
            ) : null}
            <RowButton
              label={`Remove ${key || "routing entry"}`}
              disabled={disabled}
              styles={styles}
              onPress={() => onSet(removeRecordKey(record, key))}
            />
          </View>
        );
      })}
      <RowButton
        label={`Add ${setting.path === "modelRoles" ? "model role" : fallbackChains ? "fallback chain" : "agent override"}`}
        disabled={disabled}
        styles={styles}
        onPress={() => {
          const key = nextRecordKey(record, setting.path.startsWith("task.") ? "agent" : "role");
          onSet({ ...record, [key]: fallbackChains || agentModels ? [] : "" });
        }}
      />
    </View>
  );
}

export function StructuredRoutingEditor(props: StructuredRoutingEditorProps) {
  if (!isOmpStructuredSettingPath(props.setting.path)) return null;
  const parsed = parseOmpStructuredSettingValue(props.setting.path, props.value);
  return (
    <View style={props.styles.recordList}>
      {props.resetPending ? (
        <Text style={props.styles.muted}>{props.resetLabel} when changes are applied</Text>
      ) : props.setting.path === "cycleOrder" ? (
        <OrderedRoleEditor {...props} />
      ) : props.setting.path === "task.disabledAgents" ? (
        <DisabledAgentsEditor {...props} />
      ) : (
        <RecordRoutingEditor {...props} />
      )}
      {!props.resetPending && parsed === undefined ? (
        <Text accessibilityRole="alert" style={props.styles.error}>
          Complete every routing name and value before applying changes.
        </Text>
      ) : null}
      {props.showReset ? (
        <Pressable accessibilityRole="button" disabled={props.disabled} onPress={props.onReset}>
          <Text style={props.styles.resetAction}>{props.resetLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
