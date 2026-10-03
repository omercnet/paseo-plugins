import { type PluginSidebarItemProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { contextModeSettings, getContextModeStatus } from "../shared";

// The footer stays mounted all session; poll slowly because each status miss spawns the binary.
const FOOTER_REFRESH_MS = 60_000;

export function ContextModeFooter({
  theme,
  host,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const settings = useSettings(contextModeSettings);
  const loadStatus = useRpc(getContextModeStatus);
  const status = useQuery({
    queryKey: ["context-mode", host.id, "status"],
    queryFn: () => loadStatus({ fresh: false }),
    refetchInterval: FOOTER_REFRESH_MS,
    staleTime: FOOTER_REFRESH_MS,
    enabled: settings.status === "ready",
  });
  const failing =
    settings.status === "error" ||
    settings.status === "invalid" ||
    Boolean(status.error) ||
    (status.data && status.data.state !== "ready");
  const healthy = settings.status === "ready" && !failing && status.data?.state === "ready";
  const label = failing ? "Failing" : healthy ? "Healthy" : "Checking";
  return (
    <SidebarRow
      icon="Gauge"
      label="Context Mode"
      active={currentScreen?.screenId === "context-mode"}
      onPress={() => openScreen({ screenId: "context-mode" })}
      trailing={
        <Text
          style={{
            color: failing
              ? theme.colors.statusDanger
              : healthy
                ? theme.colors.statusSuccess
                : theme.colors.foregroundMuted,
            fontSize: 12,
          }}
        >
          {label}
        </Text>
      }
    />
  );
}
