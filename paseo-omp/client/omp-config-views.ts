export type OmpConfigSurfaceView =
  | "overview"
  | "plugin"
  | "plugins"
  | "composer"
  | "configuration"
  | "diagnostics"
  | "help";

const SURFACE_VIEWS: readonly { id: OmpConfigSurfaceView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plugin", label: "Plugin" },
  { id: "plugins", label: "OMP plugins" },
  { id: "composer", label: "Composer" },
  { id: "configuration", label: "Configuration" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "help", label: "Help" },
];

export function surfaceViewsForScope(workspaceScoped: boolean) {
  return workspaceScoped
    ? SURFACE_VIEWS.filter((candidate) => candidate.id !== "composer")
    : SURFACE_VIEWS;
}
