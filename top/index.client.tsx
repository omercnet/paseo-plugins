import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TopFooter } from "./client/footer";
import { TopScreen } from "./client/screen";
import { SCREEN_ID } from "./client/usage";

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({ id: SCREEN_ID, title: "Top", Component: TopScreen });
  const removeFooter = client.addSidebarFooterItem({
    id: SCREEN_ID,
    title: "Top",
    Component: TopFooter,
  });
  return () => {
    removeFooter();
    removeScreen();
  };
}
