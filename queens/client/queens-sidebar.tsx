import { type PluginSidebarItemProps, useSettings } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { gameSettings } from "../shared/game-settings";
import { queensProgress } from "./screen-navigation";

export function QueensSidebar({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const settings = useSettings(gameSettings);
  const progress = settings.status === "ready" ? queensProgress(settings.values) : null;
  return (
    <SidebarRow
      icon="Crown"
      active={currentScreen?.screenId === "queens"}
      onPress={() => {
        if (typeof openScreen === "function")
          openScreen({ screenId: "queens", params: progress?.params });
      }}
      trailing={
        <Text
          accessibilityLiveRegion="polite"
          style={{
            fontSize: 11,
            color: progress?.solved ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
          }}
        >
          {progress
            ? `${progress.solved ? "Solved" : "Unsolved"} · ${progress.completed} completed`
            : settings.status === "loading"
              ? "Loading"
              : "Unavailable"}
        </Text>
      }
    />
  );
}
