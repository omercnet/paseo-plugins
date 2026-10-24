import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { CredentialsSection } from "./credentials-section";

export function SandboxSettingsScreen({ host }: PluginSurfaceProps) {
  return <CredentialsSection hostId={host.id} />;
}
