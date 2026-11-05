export type OmpConfigSurfaceView =
  | "overview"
  | "accounts"
  | "mcps"
  | "plugin"
  | "plugins"
  | "rules"
  | "skills"
  | "extensions"
  | "security"
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
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "security", label: "Security" },
  { id: "composer", label: "Composer" },
  { id: "configuration", label: "Configuration" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "help", label: "Help" },
];

/** Views that belong to the OMP store, not to a workspace's project settings. */
const STORE_ONLY_VIEWS: readonly OmpConfigSurfaceView[] = ["composer", "accounts", "mcps"];

/** Views about one project, which the global OMP screen has no project for. */
const WORKSPACE_ONLY_VIEWS: readonly OmpConfigSurfaceView[] = ["security"];

export function surfaceViewsForScope(workspaceScoped: boolean) {
  const hidden = workspaceScoped ? STORE_ONLY_VIEWS : WORKSPACE_ONLY_VIEWS;
  return SURFACE_VIEWS.filter((candidate) => !hidden.includes(candidate.id));
}
