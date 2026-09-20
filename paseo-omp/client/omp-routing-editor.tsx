import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
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
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered rows are edited by position and must keep input identity while their value changes.
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

function RecordRoutingEditor({
  setting,
  value,
  disabled,
  styles,
  theme,
  modelCatalog,
  modelRoles,
  onSet,
}: Pick<
  StructuredRoutingEditorProps,
  "setting" | "value" | "disabled" | "styles" | "onSet" | "theme" | "modelCatalog" | "modelRoles"
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
          // biome-ignore lint/suspicious/noArrayIndexKey: record keys are editable, so row position preserves input identity.
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
