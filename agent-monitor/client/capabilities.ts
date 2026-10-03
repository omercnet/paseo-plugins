import type { PluginClientContext } from "@getpaseo/plugin/client";

/**
 * True on hosts that register screens and live sidebar items (Paseo 0.11+). Older hosts only have
 * `addSurface` and `addSidebarItem`, and their `@getpaseo/plugin/client/ui` lacks `SidebarRow`.
 */
export function supportsScreens(
  client: Partial<Pick<PluginClientContext, "addScreen" | "addSidebarHeaderItem">>,
): boolean {
  return (
    typeof client.addScreen === "function" && typeof client.addSidebarHeaderItem === "function"
  );
}
