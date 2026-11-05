import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { OmpLspDiagnostics, OmpLspSeverity } from "../shared/lsp-diagnostics";

type Theme = PluginTimelineItemProps<OmpLspDiagnostics>["theme"];

const SEVERITY_ICON = {
  error: "CircleX",
  warning: "TriangleAlert",
  info: "Info",
  hint: "Lightbulb",
} as const;

function severityColor(theme: Theme, severity: OmpLspSeverity): string {
  if (severity === "error") return theme.colors.statusDanger;
  if (severity === "warning") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

function countLabel(data: OmpLspDiagnostics): string {
  const total = data.files.reduce((sum, file) => sum + file.diagnostics.length, 0);
  const issues = total === 1 ? "1 issue" : `${total} issues`;
  const files = data.files.length === 1 ? "1 file" : `${data.files.length} files`;
  return `LSP diagnostics: ${issues} in ${files}`;
}

export function OmpLspDiagnosticsCard({ item, theme }: PluginTimelineItemProps<OmpLspDiagnostics>) {
  const { foreground, foregroundMuted, border, surface1 } = theme.colors;
  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: surface1,
      }}
    >
      <Text style={{ color: foregroundMuted, fontSize: 13 }}>{countLabel(item.data)}</Text>
      {item.data.files.map((file) => (
        <View key={file.path} style={{ gap: 4 }}>
          <Text style={{ color: foreground, fontSize: 13, fontWeight: "500" }} selectable>
            {file.path}
          </Text>
          {file.diagnostics.map((diagnostic) => (
            <View
              key={`${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`}
              style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}
            >
              <Icon
                name={SEVERITY_ICON[diagnostic.severity]}
                size={14}
                color={severityColor(theme, diagnostic.severity)}
              />
              <Text style={{ color: foregroundMuted, fontSize: 13 }}>
                {`${diagnostic.line}:${diagnostic.column}`}
              </Text>
              <Text style={{ color: foreground, fontSize: 13, flexShrink: 1 }} selectable>
                {diagnostic.message}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
