import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { Pressable, Text, View } from "react-native";
import {
  commitPickerSelection,
  filterModelChoices,
  type OmpModelPickerChoice,
  type OmpModelPickerModel,
  thinkingSelectorChoice,
} from "./omp-model-picker-state";

type OmpModelPickerProps = {
  theme: PluginSurfaceProps["theme"];
  models: readonly OmpModelPickerModel[];
  aliases: readonly OmpModelPickerChoice[];
  role: string;
  disabled: boolean;
  loading: boolean;
  error?: string;
  onSelect(selector: string): void;
};

type OmpModelPickerStyles = {
  root: ViewStyle;
  trigger: ViewStyle;
  triggerText: TextStyle;
  panel: ViewStyle;
  search: TextStyle;
  status: TextStyle;
  error: TextStyle;
  result: ViewStyle;
  resultPressed: ViewStyle;
  titleRow: ViewStyle;
  title: TextStyle;
  selector: TextStyle;
  metadata: TextStyle;
  provenance: TextStyle;
  thinkingRow: ViewStyle;
  thinking: ViewStyle;
  buttonDisabled: ViewStyle;
  thinkingText: TextStyle;
};

function formatContextWindow(tokens?: number): string {
  if (tokens === undefined) return "Context unknown";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`;
  return `${tokens} context`;
}

export function OmpModelPicker({
  theme,
  models,
  aliases,
  role,
  disabled,
  loading,
  error,
  onSelect,
}: OmpModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const choices = useMemo(
    () => filterModelChoices(models, aliases, query, role),
    [aliases, models, query, role],
  );
  const styles = useMemo(
    () => ({
      root: { gap: 6, width: "100%" as const, maxWidth: 520 },
      trigger: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: open ? theme.colors.accent : theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
      },
      triggerText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      panel: {
        gap: 6,
        padding: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 9,
        backgroundColor: theme.colors.surface0,
      },
      search: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
        paddingHorizontal: 9,
        paddingVertical: 6,
        fontSize: 13,
      },
      status: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      result: {
        gap: 3,
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
      },
      resultPressed: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
      titleRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: 12, fontWeight: "700" as const },
      selector: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" },
      metadata: { color: theme.colors.foregroundMuted, fontSize: 11 },
      provenance: { color: theme.colors.accent, fontSize: 11, fontWeight: "600" as const },
      thinkingRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 5,
        marginTop: 3,
      },
      thinking: {
        paddingHorizontal: 7,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 999,
        backgroundColor: theme.colors.surface0,
      },
      buttonDisabled: { opacity: 0.45 },
      thinkingText: { color: theme.colors.foreground, fontSize: 10, fontWeight: "600" as const },
    }),
    [open, theme],
  );

  const choose = (selector: string) => {
    if (!commitPickerSelection(disabled, selector, onSelect)) return;
    setOpen(false);
    setQuery("");
  };

  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Close" : "Open"} model picker for ${role || "this row"}`}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen((current) => !current)}
        style={styles.trigger}
      >
        <Text style={styles.triggerText}>{open ? "Close models" : "Choose model"}</Text>
      </Pressable>
      {open ? (
        <View accessibilityLabel={`Model choices for ${role || "this row"}`} style={styles.panel}>
          <TextInput
            accessibilityLabel="Search available OMP models"
            autoFocus
            accessibilityRole="combobox"
            accessibilityState={{ expanded: true }}
            editable={!disabled}
            placeholder="Search provider, model, selector, or thinking level"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={query}
            onChangeText={setQuery}
            onKeyPress={(event) => {
              if (event.nativeEvent.key === "Escape") setOpen(false);
            }}
            style={styles.search}
          />
          {loading ? <Text style={styles.status}>Loading OMP models…</Text> : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {!loading && !error && models.length === 0 && aliases.length > 0 ? (
            <Text style={styles.status}>
              OMP reported no concrete models. Configured role aliases remain available.
            </Text>
          ) : null}
          {!loading && choices.length === 0 ? (
            <Text style={styles.status}>No models or role aliases match this search.</Text>
          ) : null}
          {choices.map((choice) =>
            choice.kind === "alias" ? (
              <Pressable
                key={choice.selector}
                accessibilityRole="button"
                accessibilityLabel={`Select role alias ${choice.selector}`}
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => choose(choice.selector)}
                style={({ pressed }) => [styles.result, pressed ? styles.resultPressed : null]}
              >
                <Text style={styles.title}>Role alias · {choice.label}</Text>
                <Text style={styles.selector}>{choice.selector}</Text>
              </Pressable>
            ) : (
              <ModelResult
                key={choice.model.selector}
                choice={choice}
                styles={styles}
                disabled={disabled}
                onSelect={choose}
              />
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}

function ModelResult({
  choice,
  styles,
  disabled,
  onSelect,
}: {
  choice: Extract<OmpModelPickerChoice, { kind: "model" }>;
  styles: OmpModelPickerStyles;
  onSelect(selector: string): void;
  disabled: boolean;
}) {
  const { model } = choice;
  const capabilityText = [
    model.reasoning ? "Reasoning" : "Standard",
    model.imageInput ? "Image input" : "Text input",
    formatContextWindow(model.contextWindow),
  ].join(" · ");
  return (
    <View style={styles.result}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Select ${model.label}, ${model.selector}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => onSelect(model.selector)}
        style={({ pressed }) => (pressed ? styles.resultPressed : undefined)}
      >
        <View style={styles.titleRow}>
          <Text style={styles.title}>{model.label}</Text>
          <Text style={styles.metadata}>{model.provider}</Text>
        </View>
        <Text style={styles.selector}>{model.selector}</Text>
        <Text style={styles.metadata}>{capabilityText}</Text>
        {choice.recommended ? (
          <Text style={styles.provenance}>Matches this role’s capabilities</Text>
        ) : null}
      </Pressable>
      {model.thinkingLevels.length > 0 ? (
        <View accessibilityLabel={`Thinking levels for ${model.label}`} style={styles.thinkingRow}>
          {model.thinkingLevels.map((level) => {
            const thinkingChoice = thinkingSelectorChoice(model.selector, level);
            const thinkingDisabled = disabled || !thinkingChoice.available;
            return (
              <Pressable
                key={level}
                accessibilityRole="button"
                accessibilityLabel={
                  thinkingChoice.available
                    ? `Select ${model.label} with ${level} thinking`
                    : `${level} thinking unavailable: selector exceeds 513 UTF-8 bytes`
                }
                accessibilityState={{ disabled: thinkingDisabled }}
                disabled={thinkingDisabled}
                onPress={() => onSelect(thinkingChoice.selector)}
                style={[styles.thinking, thinkingDisabled ? styles.buttonDisabled : null]}
              >
                <Text style={styles.thinkingText}>
                  {thinkingChoice.available ? level : `${level} · too long`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
