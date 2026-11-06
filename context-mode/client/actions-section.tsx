import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { type DoctorReport, getContextModeDoctorReport } from "../shared/actions";
import type { ContextModeProvider } from "../shared/knowledge";

const PROVIDERS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "Copilot" },
  { value: "opencode", label: "OpenCode" },
] as const satisfies ReadonlyArray<{ value: ContextModeProvider; label: string }>;

export type ActionsSectionProps = Pick<PluginSurfaceProps, "theme" | "layout">;

interface ActionsStyles {
  section: ViewStyle;
  sectionHeader: ViewStyle;
  sectionTitle: TextStyle;
  card: ViewStyle;
  cardHeader: ViewStyle;
  cardTitle: TextStyle;
  muted: TextStyle;
  choiceRow: ViewStyle;
  choice: ViewStyle;
  choiceSelected: ViewStyle;
  choiceText: TextStyle;
  choiceTextSelected: TextStyle;
  scopeNote: TextStyle;
  actions: ViewStyle;
  button: ViewStyle;
  primaryButton: ViewStyle;
  disabled: ViewStyle;
  buttonText: TextStyle;
  primaryButtonText: TextStyle;
  pendingRow: ViewStyle;
  activity: { color: string };
  error: TextStyle;
  doctorRows: ViewStyle;
  doctorRow: ViewStyle;
  doctorMarker: ViewStyle;
  doctorMarkerOk: ViewStyle;
  doctorMarkerWarning: ViewStyle;
  doctorMarkerError: ViewStyle;
  doctorCopy: ViewStyle;
  doctorTopline: ViewStyle;
  doctorCheck: TextStyle;
  doctorStatus: TextStyle;
  doctorStatusOk: TextStyle;
  doctorStatusWarning: TextStyle;
  doctorStatusError: TextStyle;
  doctorDetail: TextStyle;
  rawFrame: ViewStyle;
  rawOutput: TextStyle;
  propertyLabel: TextStyle;
  argumentFrame: ViewStyle;
  metaRow: ViewStyle;
  badge: ViewStyle;
  badgeText: TextStyle;
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  primary = false,
  styles,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  styles: ActionsStyles;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.primaryButton : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, primary ? styles.primaryButtonText : null]}>{label}</Text>
    </Pressable>
  );
}

function DoctorResult({
  report,
  pending,
  error,
  styles,
}: {
  report: DoctorReport | undefined;
  pending: boolean;
  error: unknown;
  styles: ActionsStyles;
}) {
  const [showRaw, setShowRaw] = useState(false);
  if (pending) {
    return (
      <View accessibilityLiveRegion="polite" style={styles.pendingRow}>
        <ActivityIndicator size="small" color={styles.activity.color} />
        <Text style={styles.muted}>Running diagnostics…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <Text accessibilityRole="alert" style={styles.error}>
        {error instanceof Error ? error.message : String(error)}
      </Text>
    );
  }
  if (!report) return null;

  const hasRows = report.rows.length > 0;
  const rawVisible = !hasRows || showRaw;
  return (
    <View accessibilityLiveRegion="polite" style={styles.doctorRows}>
      <View style={styles.metaRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{report.platform}</Text>
        </View>
        {hasRows && report.rawOutput.trim() ? (
          <ActionButton
            label={showRaw ? "Hide raw diagnostics" : "Show raw diagnostics"}
            onPress={() => setShowRaw((visible) => !visible)}
            styles={styles}
          />
        ) : null}
      </View>
      {report.rows.map((row) => {
        const ok = row.status === "ok";
        const warning = row.status === "warning";
        const statusLabel = ok ? "OK" : warning ? "Warning" : "Error";
        return (
          <View
            key={`${row.status}:${row.check}:${row.detail}`}
            accessibilityLabel={`${row.check}: ${statusLabel}. ${row.detail}`}
            style={styles.doctorRow}
          >
            <View
              style={[
                styles.doctorMarker,
                ok
                  ? styles.doctorMarkerOk
                  : warning
                    ? styles.doctorMarkerWarning
                    : styles.doctorMarkerError,
              ]}
            />
            <View style={styles.doctorCopy}>
              <View style={styles.doctorTopline}>
                <Text style={styles.doctorCheck}>{row.check}</Text>
                <Text
                  style={[
                    styles.doctorStatus,
                    ok
                      ? styles.doctorStatusOk
                      : warning
                        ? styles.doctorStatusWarning
                        : styles.doctorStatusError,
                  ]}
                >
                  {statusLabel}
                </Text>
              </View>
              {row.detail ? (
                <Text selectable style={styles.doctorDetail}>
                  {row.detail}
                </Text>
              ) : null}
              {row.fix ? (
                <Text selectable style={styles.doctorDetail}>
                  Fix: {row.fix}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
      {rawVisible ? (
        <View style={styles.rawFrame}>
          <Text style={styles.propertyLabel}>Raw diagnostic output</Text>
          <ScrollView nestedScrollEnabled style={styles.argumentFrame}>
            <Text selectable style={styles.rawOutput}>
              {report.rawOutput || "Context Mode returned no diagnostic text."}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

export function ActionsSection({ theme, layout }: ActionsSectionProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const loadDoctor = useRpc(getContextModeDoctorReport);
  const [provider, setProvider] = useState<ContextModeProvider | null>("claude");
  const providerLabel = PROVIDERS.find((item) => item.value === provider)?.label ?? null;
  const doctor = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select a provider before running diagnostics.");
      return loadDoctor({ provider });
    },
  });

  const changeProvider = (next: ContextModeProvider) => {
    setProvider(next);
    doctor.reset();
  };
  const busy = doctor.isPending;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Diagnostics
        </Text>
        <Text style={styles.muted}>Health checks for the bundled Context Mode runtime.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Target provider</Text>
        <View accessibilityRole="radiogroup" style={styles.choiceRow}>
          {PROVIDERS.map((option) => {
            const selected = provider === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityLabel={`${option.label} action target`}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: busy }}
                disabled={busy}
                onPress={() => changeProvider(option.value)}
                style={[
                  styles.choice,
                  selected ? styles.choiceSelected : null,
                  busy ? styles.disabled : null,
                ]}
              >
                <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text accessibilityLiveRegion="polite" style={styles.scopeNote}>
          {providerLabel
            ? `Diagnostics will target ${providerLabel}.`
            : "Select a provider before running diagnostics."}
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Doctor
          </Text>
          <Text style={styles.muted}>
            Run checks against a Paseo-owned probe store, so your project data is untouched.
            Structured rows are shown first; the original diagnostic text remains available.
          </Text>
        </View>
        <View style={styles.actions}>
          <ActionButton
            disabled={!provider || busy}
            label={doctor.isPending ? "Running doctor…" : "Run doctor"}
            onPress={() => doctor.mutate()}
            primary
            styles={styles}
          />
        </View>
        <DoctorResult
          error={doctor.error}
          pending={doctor.isPending}
          report={doctor.data}
          styles={styles}
        />
      </View>
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean): ActionsStyles {
  return {
    section: { width: "100%", gap: compact ? 12 : 16 },
    sectionHeader: { gap: 4 },
    sectionTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 18 : 20,
      fontWeight: "700",
    },
    card: {
      width: "100%",
      gap: 12,
      padding: compact ? 12 : 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    cardHeader: { gap: 3 },
    cardTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "700" },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
    choice: {
      minHeight: 36,
      justifyContent: "center",
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 999,
      backgroundColor: theme.colors.surface0,
    },
    choiceSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    choiceText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    choiceTextSelected: { color: theme.colors.accentForeground },
    scopeNote: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    button: {
      minHeight: 38,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 13,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    primaryButton: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    disabled: { opacity: 0.5 },
    buttonText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
    primaryButtonText: { color: theme.colors.accentForeground },
    pendingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    activity: { color: theme.colors.accent },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
    doctorRows: { gap: 8 },
    doctorRow: {
      flexDirection: "row",
      gap: 9,
      padding: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    doctorMarker: { width: 4, minHeight: 32, borderRadius: 999 },
    doctorMarkerOk: { backgroundColor: theme.colors.statusSuccess },
    doctorMarkerWarning: { backgroundColor: theme.colors.statusWarning },
    doctorMarkerError: { backgroundColor: theme.colors.statusDanger },
    doctorCopy: { flex: 1, minWidth: 0, gap: 3 },
    doctorTopline: {
      flexDirection: compact ? "column" : "row",
      alignItems: compact ? "flex-start" : "center",
      gap: 6,
    },
    doctorCheck: {
      flex: compact ? undefined : 1,
      color: theme.colors.foreground,
      fontWeight: "600",
    },
    doctorStatus: { fontSize: 11, fontWeight: "700" },
    doctorStatusOk: { color: theme.colors.statusSuccess },
    doctorStatusWarning: { color: theme.colors.statusWarning },
    doctorStatusError: { color: theme.colors.statusDanger },
    doctorDetail: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    rawFrame: {
      gap: 6,
      padding: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    rawOutput: {
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: compact ? 11 : 12,
      lineHeight: compact ? 16 : 18,
    },
    propertyLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600",
    },
    argumentFrame: { maxHeight: compact ? 160 : 220 },
    metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7 },
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 999,
      backgroundColor: theme.colors.surface2,
    },
    badgeText: { color: theme.colors.foreground, fontSize: 11, fontWeight: "600" },
  };
}
