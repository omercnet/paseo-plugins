import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { OmpAstEdit } from "../shared/ast-edit";

function countLabel(data: OmpAstEdit): string {
  const total = data.files.reduce((sum, file) => sum + file.changes.length, 0);
  const changes = total === 1 ? "1 change" : `${total} changes`;
  const files = data.files.length === 1 ? "1 file" : `${data.files.length} files`;
  return `AST edit preview: ${changes} in ${files}`;
}

export function OmpAstEditCard({ item, theme }: PluginTimelineItemProps<OmpAstEdit>) {
  const { foreground, foregroundMuted, border, surface1, statusDanger, statusSuccess } =
    theme.colors;
  const code = { fontFamily: "monospace", fontSize: 12, flexShrink: 1 } as const;
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
        <View key={file.path} style={{ gap: 2 }}>
          <Text style={{ color: foreground, fontSize: 13, fontWeight: "500" }} selectable>
            {file.path}
          </Text>
          {file.changes.map((change, index) => (
            <View key={`${index}:${change.line}`} style={{ gap: 1 }}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Text style={{ ...code, color: foregroundMuted, minWidth: 28 }}>{change.line}</Text>
                <Text style={{ ...code, color: statusDanger }} selectable>
                  {`- ${change.before}`}
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Text style={{ ...code, minWidth: 28 }}> </Text>
                <Text style={{ ...code, color: statusSuccess }} selectable>
                  {`+ ${change.after}`}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
