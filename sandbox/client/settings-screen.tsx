import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";
import { CredentialsSection } from "./credentials-section";

export function SandboxSettingsScreen({ theme, layout, host }: PluginSurfaceProps) {
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24 }}>
      <CredentialsSection hostId={host.id} theme={theme} />
    </ScrollView>
  );
}
