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
import {
  CONTEXT_MODE_TARGET_VERSION,
  type ContextModeAction,
  type DoctorReport,
  getContextModeDoctorReport,
  getContextModeInstallAction,
  getContextModeUpgradeAction,
} from "../shared/actions";
import type { ContextModeProvider } from "../shared/knowledge";

const PROVIDERS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "copilot", label: "Copilot" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
  { value: "omp", label: "OMP" },
  { value: "omp-plugin", label: "OMP plugin" },
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
  commandCard: ViewStyle;
  commandTitle: TextStyle;
  property: ViewStyle;
  propertyLabel: TextStyle;
  propertyValue: TextStyle;
  argumentFrame: ViewStyle;
  argumentRow: ViewStyle;
  argumentIndex: TextStyle;
  argumentValue: TextStyle;
  metaRow: ViewStyle;
  badge: ViewStyle;
  badgeText: TextStyle;
  warningBadge: ViewStyle;
  warningBadgeText: TextStyle;
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

function CommandResult({
  title,
  action,
  pending,
  error,
  styles,
}: {
  title: string;
  action: ContextModeAction | undefined;
  pending: boolean;
  error: unknown;
  styles: ActionsStyles;
}) {
  if (pending) {
    return (
      <View accessibilityLiveRegion="polite" style={styles.pendingRow}>
        <ActivityIndicator size="small" color={styles.activity.color} />
        <Text style={styles.muted}>Preparing {title.toLowerCase()}…</Text>
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
  if (!action) return null;

  const seenArguments = new Map<string, number>();
  const argumentsWithKeys = action.args.map((argument, index) => {
    const occurrence = seenArguments.get(argument) ?? 0;
    seenArguments.set(argument, occurrence + 1);
    return { argument, position: index + 1, key: `${argument}:${occurrence}` };
  });

  return (
    <View accessibilityLiveRegion="polite" style={styles.commandCard}>
      <View style={styles.cardHeader}>
        <Text style={styles.commandTitle}>{title}</Text>
        <Text style={styles.muted}>
          Review this executable and argument list before running it outside Paseo.
        </Text>
      </View>
      <View style={styles.property}>
        <Text style={styles.propertyLabel}>Program</Text>
        <Text selectable style={styles.propertyValue}>
          {action.program}
        </Text>
      </View>
      <View style={styles.property}>
        <Text style={styles.propertyLabel}>Arguments ({action.args.length})</Text>
        <ScrollView nestedScrollEnabled style={styles.argumentFrame}>
          {action.args.length ? (
            argumentsWithKeys.map(({ argument, key, position }) => (
              <View key={key} style={styles.argumentRow}>
                <Text style={styles.argumentIndex}>{position}</Text>
                <Text selectable style={styles.argumentValue}>
                  {argument}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.muted}>No arguments.</Text>
          )}
        </ScrollView>
      </View>
      <View style={styles.metaRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{action.platform}</Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {action.currentVersion ? `${action.currentVersion} → ` : "Install "}
            {action.targetVersion}
          </Text>
        </View>
        {action.requiresRestart ? (
          <View style={styles.warningBadge}>
            <Text style={styles.warningBadgeText}>Restart required</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function ActionsSection({ theme, layout }: ActionsSectionProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const loadDoctor = useRpc(getContextModeDoctorReport);
  const loadInstall = useRpc(getContextModeInstallAction);
  const loadUpgrade = useRpc(getContextModeUpgradeAction);
  const [provider, setProvider] = useState<ContextModeProvider | null>("claude");
  const doctor = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select a provider before running diagnostics.");
      return loadDoctor({ provider });
    },
  });
  const install = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select a provider before preparing an install command.");
      return loadInstall({ provider });
    },
  });
  const upgrade = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Select a provider before preparing an upgrade command.");
      return loadUpgrade({ provider });
    },
  });

  const changeProvider = (next: ContextModeProvider) => {
    setProvider(next);
    doctor.reset();
    install.reset();
    upgrade.reset();
  };
  const busy = doctor.isPending || install.isPending || upgrade.isPending;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Diagnostics and setup
        </Text>
        <Text style={styles.muted}>Health checks, installation, and upgrades.</Text>
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
          {provider
            ? `Diagnostics and commands will target ${PROVIDERS.find((item) => item.value === provider)?.label}.`
            : "Select a provider before requesting a diagnostic or command."}
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Doctor
          </Text>
          <Text style={styles.muted}>
            Run read-only checks. Structured rows are shown first; the original diagnostic text
            remains available as a fallback.
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

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Install or upgrade
          </Text>
          <Text style={styles.muted}>
            Install requests pin Context Mode {CONTEXT_MODE_TARGET_VERSION}; upgrades target the
            latest release. Paseo shows the exact command; run it yourself.
          </Text>
        </View>
        <View style={styles.actions}>
          <ActionButton
            disabled={!provider || busy}
            label={install.isPending ? "Preparing install…" : "Prepare install"}
            onPress={() => install.mutate()}
            styles={styles}
          />
          <ActionButton
            disabled={!provider || busy}
            label={upgrade.isPending ? "Preparing upgrade…" : "Prepare upgrade"}
            onPress={() => upgrade.mutate()}
            styles={styles}
          />
        </View>
        <CommandResult
          action={install.data}
          error={install.error}
          pending={install.isPending}
          styles={styles}
          title="Install command"
        />
        <CommandResult
          action={upgrade.data}
          error={upgrade.error}
          pending={upgrade.isPending}
          styles={styles}
          title="Upgrade command"
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
    commandCard: {
      gap: 10,
      padding: 11,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    commandTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" },
    property: { gap: 4 },
    propertyLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600",
    },
    propertyValue: {
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: compact ? 11 : 12,
      lineHeight: compact ? 16 : 18,
    },
    argumentFrame: { maxHeight: compact ? 160 : 220 },
    argumentRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      paddingVertical: 4,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    argumentIndex: {
      width: 22,
      color: theme.colors.foregroundMuted,
      fontFamily: "monospace",
      fontSize: 11,
    },
    argumentValue: {
      flex: 1,
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: compact ? 11 : 12,
      lineHeight: compact ? 16 : 18,
    },
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
    warningBadge: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: theme.colors.statusWarning,
      borderRadius: 999,
      backgroundColor: theme.colors.surface1,
    },
    warningBadgeText: { color: theme.colors.statusWarning, fontSize: 11, fontWeight: "600" },
  };
}
