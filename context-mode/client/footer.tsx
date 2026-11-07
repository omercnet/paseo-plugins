import { type PluginSidebarItemProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { getContextModeStatus } from "../shared/contracts";
import { contextModeSettings } from "../shared/settings";

// The footer stays mounted all session; poll slowly because each status miss spawns the binary.
const FOOTER_REFRESH_MS = 60_000;

type FooterHealth = "failing" | "healthy" | "checking";

const HEALTH_LABELS: Record<FooterHealth, string> = {
  failing: "Failing",
  healthy: "Healthy",
  checking: "Checking",
};

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
  const settingsFailed = settings.status === "error" || settings.status === "invalid";
  const statusFailed = Boolean(status.error) || status.data?.state === "unavailable";
  const statusReady = settings.status === "ready" && status.data?.state === "ready";
  let health: FooterHealth = "checking";
  if (settingsFailed || statusFailed) health = "failing";
  else if (statusReady) health = "healthy";
  const healthColors: Record<FooterHealth, string> = {
    failing: theme.colors.statusDanger,
    healthy: theme.colors.statusSuccess,
    checking: theme.colors.foregroundMuted,
  };
  return (
    <SidebarRow
      icon="Gauge"
      label="Context Mode"
      active={currentScreen?.screenId === "context-mode"}
      onPress={() => openScreen({ screenId: "context-mode" })}
      trailing={
        <Text style={{ color: healthColors[health], fontSize: 12 }}>{HEALTH_LABELS[health]}</Text>
      }
    />
  );
}
