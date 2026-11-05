export type OmpConfigSurfaceView =
  | "overview"
  | "accounts"
  | "mcps"
  | "plugin"
  | "plugins"
  | "rules"
  | "composer"
  | "configuration"
  | "diagnostics"
  | "help";

const SURFACE_VIEWS: readonly { id: OmpConfigSurfaceView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "accounts", label: "Accounts" },
  { id: "mcps", label: "MCPs" },
  { id: "plugin", label: "Plugin" },
  { id: "plugins", label: "OMP plugins" },
  { id: "rules", label: "Rules" },
  { id: "composer", label: "Composer" },
  { id: "configuration", label: "Configuration" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "help", label: "Help" },
];

/** Views that belong to the OMP store, not to a workspace's project settings. */
const STORE_ONLY_VIEWS: readonly OmpConfigSurfaceView[] = ["composer", "accounts", "mcps"];

export function surfaceViewsForScope(workspaceScoped: boolean) {
  return workspaceScoped
    ? SURFACE_VIEWS.filter((candidate) => !STORE_ONLY_VIEWS.includes(candidate.id))
    : SURFACE_VIEWS;
}
