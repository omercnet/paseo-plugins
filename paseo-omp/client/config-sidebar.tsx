import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { OMP_ICON } from "./hub-icon";
import { CONFIG_SCREEN_ID } from "./sidebar-compat";

export function ConfigSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={OMP_ICON}
      label="OMP"
      active={currentScreen?.screenId === CONFIG_SCREEN_ID}
      onPress={() => openScreen({ screenId: CONFIG_SCREEN_ID })}
    />
  );
}
