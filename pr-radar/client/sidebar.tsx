import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, ScrollView, Text } from "react-native";
import { needsYouSummary } from "./screen-state";
import { useRadar } from "./use-radar";

function NeedsYouPopover({ theme, layout, host, openScreen }: PluginPopoverProps) {
  const queue = useRadar(host.id, 30, false);
  const { items } = needsYouSummary(queue.rows, queue.loading, queue.warnings);
  return (
    <ScrollView
      style={{ maxHeight: layout.compact ? 460 : 400 }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700" }}>
        Needs you
      </Text>
      {queue.viewerData ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>{queue.viewerData.coverageNote}</Text>
      ) : null}
      {queue.warnings.map((warning) => (
        <Text key={warning} style={{ color: theme.colors.statusWarning }}>
          {warning}
        </Text>
      ))}
      {queue.loading ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>Scanning pull requests…</Text>
      ) : null}
      {!queue.loading && !items.length ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {queue.warnings.length
            ? "No known items need you in the available results."
            : "No pull requests need you in this scope."}
        </Text>
      ) : null}
      {!queue.loading &&
        items.map((row) => (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            onPress={() => openScreen({ screenId: "radar", params: { pr: row.id } })}
            style={{
              paddingVertical: 10,
              borderTopWidth: 1,
              borderColor: theme.colors.border,
              gap: 4,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
              {row.repository}#{row.number} · {row.title}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted }}>{row.reason}</Text>
          </Pressable>
        ))}
      <Pressable
        accessibilityRole="button"
        onPress={() => openScreen({ screenId: "radar", params: { filter: "needs-you" } })}
        style={{ paddingVertical: 10 }}
      >
        <Text style={{ color: theme.colors.accent }}>Open needs-you queue</Text>
      </Pressable>
    </ScrollView>
  );
}

export function RadarSidebar({
  theme,
  host,
  currentScreen,
  openScreen,
  openPopover,
}: PluginSidebarItemProps) {
  const queue = useRadar(host.id, 30, currentScreen?.screenId !== "radar");
  const summary = needsYouSummary(queue.rows, queue.loading, queue.warnings);
  return (
    <SidebarRow
      icon="GitPullRequest"
      active={currentScreen?.screenId === "radar"}
      onPress={() => openScreen({ screenId: "radar" })}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Needs you: ${summary.label}${queue.warnings.length ? "; incomplete results" : ""}`}
          onPress={() => openPopover(NeedsYouPopover)}
          style={{ paddingHorizontal: 8, paddingVertical: 6 }}
        >
          <Text
            style={{
              color: queue.warnings.length ? theme.colors.statusWarning : theme.colors.foreground,
              fontSize: 12,
            }}
          >
            {summary.label} needs you
          </Text>
        </Pressable>
      }
    />
  );
}
