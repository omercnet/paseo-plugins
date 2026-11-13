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
  { id: "plugin", label: "Plugin provider" },
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

/** Views about one project: the workspace panel adds them, and the global OMP screen has no project for them. Every other view is on both surfaces. */
const WORKSPACE_ONLY_VIEWS: readonly OmpConfigSurfaceView[] = ["security"];

interface SurfaceScope {
  workspaceScoped: boolean;
  /** The plugin's own `omp-plugin` providers; the Plugin provider view only applies to them. */
  pluginProviderEnabled: boolean;
}

export function surfaceViewsForScope({ workspaceScoped, pluginProviderEnabled }: SurfaceScope) {
  const hidden = workspaceScoped ? [] : WORKSPACE_ONLY_VIEWS;
  return SURFACE_VIEWS.filter(
    (candidate) =>
      !hidden.includes(candidate.id) && (pluginProviderEnabled || candidate.id !== "plugin"),
  );
}

/** A view the current scope or provider state hides falls back to Overview, never a blank screen. */
export function resolveSurfaceView(
  views: readonly { id: OmpConfigSurfaceView }[],
  selected: OmpConfigSurfaceView,
): OmpConfigSurfaceView {
  return views.some((candidate) => candidate.id === selected) ? selected : "overview";
}
