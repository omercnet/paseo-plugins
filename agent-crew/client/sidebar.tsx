import type {
  PluginClientContext,
  PluginPopoverProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { activeCrews, agentTitle, crewPopoverNotice } from "./crew";
import { useCrewDirectory } from "./main";

/** The Active crews sidebar row; its popover opens a crew's workspace Agent Crew panel. */
export function createActiveCrewsItem(client: PluginClientContext) {
  function ActiveCrewsPopover({ theme, host, close }: PluginPopoverProps) {
    const toast = useToast();
    const { data, error, isPending } = useCrewDirectory(host.id);
    const crews = useMemo(() => activeCrews(data?.entries ?? []), [data]);
    const styles = useMemo(
      () =>
        StyleSheet.create({
          row: { gap: 2, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8 },
          pressed: { backgroundColor: theme.colors.surface2 },
          title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
          detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
          error: { color: theme.colors.statusDanger, fontSize: 12, marginBottom: 6 },
        }),
      [theme],
    );
    const notice = crewPopoverNotice({ crewCount: crews.length, isPending, error });
    let noticeText = "No crew is working or waiting for input.";
    if (notice === "loading") noticeText = "Loading crews…";
    if (notice === "error") {
      noticeText = error instanceof Error ? error.message : "Could not load crews";
    }
    return (
      <View>
        {notice ? (
          <Text style={notice === "error" ? styles.error : styles.detail}>{noticeText}</Text>
        ) : null}
        {crews.map((crew) => (
          <Pressable
            key={`${crew.workspaceId}:${crew.lead.agent.id}`}
            accessibilityRole="button"
            onPress={() => {
              close();
              try {
                client.openPanel("crew", { workspaceId: crew.workspaceId, location: "explorer" });
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not open Agent Crew");
              }
            }}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Text style={styles.title} numberOfLines={1}>
              {agentTitle(crew.lead)}
            </Text>
            <Text style={styles.detail} numberOfLines={1}>
              {[
                data?.workspaceNames.get(crew.workspaceId) ?? "Unknown workspace",
                crew.working > 0 ? `${crew.working} working` : null,
                crew.needsInput > 0 ? `${crew.needsInput} need input` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  }

  function ActiveCrewsItem({ theme, host, openPopover }: PluginSidebarItemProps) {
    const { data } = useCrewDirectory(host.id);
    const count = useMemo(() => activeCrews(data?.entries ?? []).length, [data]);
    return (
      <SidebarRow
        icon="Network"
        onPress={() => openPopover(ActiveCrewsPopover)}
        trailing={
          count > 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{count}</Text>
          ) : undefined
        }
      />
    );
  }

  return ActiveCrewsItem;
}
