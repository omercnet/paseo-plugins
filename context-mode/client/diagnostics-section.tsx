import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import {
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  type DoctorReport,
  type DoctorStatusRow,
  getContextModeDoctorReport,
} from "../shared/actions";
import { CONTEXT_MODE_PROVIDERS, type ContextModeProvider } from "../shared/providers";
import {
  ActionButton,
  Card,
  type ChoiceOption,
  errorMessage,
  Pending,
  StatusPill,
  type StatusTone,
} from "./controls";

const PROVIDER_OPTIONS: readonly ChoiceOption<ContextModeProvider>[] = CONTEXT_MODE_PROVIDERS.map(
  ({ provider, label }) => ({ value: provider, label }),
);

interface DoctorStatusPresentation {
  label: string;
  tone: StatusTone;
}

const DOCTOR_STATUS: Record<DoctorStatusRow["status"], DoctorStatusPresentation> = {
  ok: { label: "OK", tone: "success" },
  warning: { label: "Warning", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

interface DiagnosticsSectionProps {
  theme: PluginTheme;
}

export function DiagnosticsSection({ theme }: DiagnosticsSectionProps) {
  const loadDoctor = useRpc(getContextModeDoctorReport);
  const [provider, setProvider] = useState<ContextModeProvider>("claude");
  const doctor = useMutation({
    mutationFn: (target: ContextModeProvider) => loadDoctor({ provider: target }),
  });

  function changeProvider(next: ContextModeProvider) {
    setProvider(next);
    doctor.reset();
  }

  return (
    <SettingsSection
      title="Diagnostics"
      info="Doctor runs against a Paseo-owned probe store, so your project data is untouched."
    >
      <View style={{ gap: 16 }}>
        <SettingsCard>
          <SettingsSelect
            label="Provider"
            value={provider}
            options={PROVIDER_OPTIONS}
            disabled={doctor.isPending}
            onValueChange={changeProvider}
          />
          <SettingsAction
            label="Doctor"
            hint="Health checks for the Context Mode runtime"
            actionLabel={doctor.isPending ? "Running..." : "Run doctor"}
            disabled={doctor.isPending}
            error={doctor.error ? errorMessage(doctor.error) : null}
            onPress={() => doctor.mutate(provider)}
          />
        </SettingsCard>
        {doctor.isPending ? <Pending theme={theme} label="Running diagnostics..." /> : null}
        {doctor.data ? <DoctorResult report={doctor.data} theme={theme} /> : null}
      </View>
    </SettingsSection>
  );
}

interface DoctorResultProps {
  report: DoctorReport;
  theme: PluginTheme;
}

function DoctorResult({ report, theme }: DoctorResultProps) {
  const [showRaw, setShowRaw] = useState(false);
  const hasRows = report.rows.length > 0;
  const hasRawOutput = report.rawOutput.trim().length > 0;
  const rawVisible = !hasRows || showRaw;
  const mutedStyle = { color: theme.colors.foregroundMuted, fontSize: 12 };

  return (
    <Card theme={theme}>
      <View accessibilityLiveRegion="polite" style={{ gap: 12 }}>
        <Text style={mutedStyle}>Checked as {report.platform}</Text>
        {report.rows.map((row) => (
          <DoctorRow key={`${row.status}:${row.check}:${row.detail}`} row={row} theme={theme} />
        ))}
        {hasRows && hasRawOutput ? (
          <ActionButton
            theme={theme}
            variant="outline"
            expanded={showRaw}
            label={showRaw ? "Hide raw diagnostics" : "Show raw diagnostics"}
            onPress={() => setShowRaw((visible) => !visible)}
          />
        ) : null}
        {rawVisible ? <RawOutput output={report.rawOutput} theme={theme} /> : null}
      </View>
    </Card>
  );
}

interface DoctorRowProps {
  row: DoctorStatusRow;
  theme: PluginTheme;
}

function DoctorRow({ row, theme }: DoctorRowProps) {
  const status = DOCTOR_STATUS[row.status];
  const detailStyle = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 };
  return (
    <View accessibilityLabel={`${row.check}: ${status.label}. ${row.detail}`} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ flexShrink: 1, color: theme.colors.foreground }}>{row.check}</Text>
        <StatusPill theme={theme} label={status.label} tone={status.tone} />
      </View>
      {row.detail ? (
        <Text selectable style={detailStyle}>
          {row.detail}
        </Text>
      ) : null}
      {row.fix ? (
        <Text selectable style={detailStyle}>
          Fix: {row.fix}
        </Text>
      ) : null}
    </View>
  );
}

interface RawOutputProps {
  output: string;
  theme: PluginTheme;
}

function RawOutput({ output, theme }: RawOutputProps) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" }}>
        Raw diagnostic output
      </Text>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }}>
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontFamily: "monospace",
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {output || "No diagnostic text"}
        </Text>
      </ScrollView>
    </View>
  );
}
