import type { PluginTheme } from "@getpaseo/plugin";
import { Loading } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

/**
 * `primary`: the one accent action on a surface. `secondary`: the default. `outline`: a quiet row
 * action. `destructive`: only the confirm button inside a confirmation.
 */
export type ButtonVariant = "primary" | "secondary" | "outline" | "destructive";

interface ActionButtonProps {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  variant?: ButtonVariant;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Set for disclosure buttons so assistive tech hears the expanded state. */
  expanded?: boolean;
}

interface ButtonColors {
  background: string;
  border: string;
  text: string;
}

function buttonColors(theme: PluginTheme, variant: ButtonVariant): ButtonColors {
  const { colors } = theme;
  const byVariant: Record<ButtonVariant, ButtonColors> = {
    primary: { background: colors.accent, border: colors.accent, text: colors.accentForeground },
    secondary: { background: colors.surface2, border: colors.surface2, text: colors.foreground },
    outline: { background: "transparent", border: colors.border, text: colors.foreground },
    destructive: {
      background: colors.statusDanger,
      border: colors.statusDanger,
      text: colors.accentForeground,
    },
  };
  return byVariant[variant];
}

export function ActionButton({
  theme,
  label,
  onPress,
  variant = "secondary",
  disabled = false,
  accessibilityLabel,
  expanded,
}: ActionButtonProps) {
  const colors = buttonColors(theme, variant);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 32,
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "flex-start",
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 999,
        backgroundColor: colors.background,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export type StatusTone = "success" | "warning" | "danger" | "neutral";

function toneColor(theme: PluginTheme, tone: StatusTone): string {
  const byTone: Record<StatusTone, string> = {
    success: theme.colors.statusSuccess,
    warning: theme.colors.statusWarning,
    danger: theme.colors.statusDanger,
    neutral: theme.colors.foreground,
  };
  return byTone[tone];
}

interface StatusPillProps {
  theme: PluginTheme;
  label: string;
  tone: StatusTone;
}

/** Status text in its status token on the neutral pill shell. */
export function StatusPill({ theme, label, tone }: StatusPillProps) {
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text style={{ color: toneColor(theme, tone), fontSize: 12, fontWeight: "400" }}>
        {label}
      </Text>
    </View>
  );
}

export interface ChoiceOption<Value extends string> {
  value: Value;
  label: string;
}

interface ChoicesProps<Value extends string> {
  theme: PluginTheme;
  options: readonly ChoiceOption<Value>[];
  /** Null when nothing is selected yet. */
  value: Value | null;
  onChange(value: Value): void;
  accessibilityLabel(option: ChoiceOption<Value>): string;
  disabled?: boolean;
  /** `tab` renders a tablist; otherwise a radio group. */
  role?: "radio" | "tab";
}

/** Segmented choice: the selected segment is a surface fill with foreground text. */
export function Choices<Value extends string>({
  theme,
  options,
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
  role = "radio",
}: ChoicesProps<Value>) {
  return (
    <View
      accessibilityRole={role === "tab" ? "tablist" : "radiogroup"}
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignSelf: role === "tab" ? "stretch" : "flex-start",
        gap: 4,
        padding: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((option) => (
        <ChoiceSegment
          key={option.value}
          accessibilityLabel={accessibilityLabel(option)}
          disabled={disabled}
          label={option.label}
          onPress={() => onChange(option.value)}
          role={role}
          selected={value === option.value}
          stretch={role === "tab"}
          theme={theme}
        />
      ))}
    </View>
  );
}

interface ChoiceSegmentProps {
  theme: PluginTheme;
  label: string;
  accessibilityLabel: string;
  selected: boolean;
  disabled: boolean;
  stretch: boolean;
  role: "radio" | "tab";
  onPress(): void;
}

function ChoiceSegment({
  theme,
  label,
  accessibilityLabel,
  selected,
  disabled,
  stretch,
  role,
  onPress,
}: ChoiceSegmentProps) {
  const state = role === "tab" ? { selected, disabled } : { checked: selected, disabled };
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={role}
      accessibilityState={state}
      disabled={disabled}
      onPress={onPress}
      style={{
        flexGrow: stretch ? 1 : 0,
        minHeight: 32,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: selected ? theme.colors.surface2 : "transparent",
      }}
    >
      <Text
        style={{
          color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
          fontSize: 13,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

interface CardProps {
  theme: PluginTheme;
  children: ReactNode;
}

/** A bordered group of related content. */
export function Card({ theme, children }: CardProps) {
  return (
    <View
      style={{
        width: "100%",
        gap: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

interface PendingProps {
  theme: PluginTheme;
  label: string;
}

/** Inline loading: the host spinner beside a short in-flight label. */
export function Pending({ theme, label }: PendingProps) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <View style={{ width: 16, height: 16 }}>
        <Loading />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ErrorTextProps {
  theme: PluginTheme;
  error: unknown;
}

/** One-sentence failure under the control it belongs to. Renders nothing without an error. */
export function ErrorText({ theme, error }: ErrorTextProps) {
  if (!error) return null;
  return (
    <Text
      accessibilityRole="alert"
      style={{ color: theme.colors.statusDanger, fontSize: 12, lineHeight: 16 }}
    >
      {errorMessage(error)}
    </Text>
  );
}
