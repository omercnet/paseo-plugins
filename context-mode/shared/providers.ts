import { z } from "zod";

/** Paseo providers Context Mode 2 serves over MCP. */
export const ContextModeProviderSchema = z.enum(["claude", "codex", "copilot", "opencode"]);

/** Context Mode 2 `--agent` ids for those providers. */
export const ContextModePlatformSchema = z.enum([
  "claude-code",
  "codex",
  "copilot-cli",
  "opencode",
]);

export type ContextModeProvider = z.infer<typeof ContextModeProviderSchema>;
export type ContextModePlatform = z.infer<typeof ContextModePlatformSchema>;

interface ProviderEntry {
  provider: ContextModeProvider;
  platform: ContextModePlatform;
  label: string;
}

/** The one mapping between Paseo providers, Context Mode agent ids, and display labels. */
export const CONTEXT_MODE_PROVIDERS: readonly ProviderEntry[] = [
  { provider: "claude", platform: "claude-code", label: "Claude" },
  { provider: "codex", platform: "codex", label: "Codex" },
  { provider: "copilot", platform: "copilot-cli", label: "Copilot" },
  { provider: "opencode", platform: "opencode", label: "OpenCode" },
];

export function contextModePlatformFor(provider: ContextModeProvider): ContextModePlatform {
  const entry = CONTEXT_MODE_PROVIDERS.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`No Context Mode agent id for provider ${provider}.`);
  return entry.platform;
}

interface InProcessEntry {
  provider: string;
  agent: string;
  label: string;
}

/**
 * Context Mode runs inside these hosts as an extension, so Paseo cannot inject it, but they record
 * sessions in the same store under their own agent id.
 */
export const IN_PROCESS_PROVIDERS: readonly InProcessEntry[] = [
  { provider: "pi", agent: "pi", label: "Pi" },
];

/**
 * Agent id of the panel's own Context Mode process when no injectable agent applies: `--agent pi`
 * cannot resolve a project over MCP, and the panel's calls are its own session anyway.
 */
export const PANEL_PLATFORM: ContextModePlatform = "claude-code";

/** The Paseo provider that owns a Context Mode agent id recorded in a database, if any. */
export function providerForPlatform(platform: string): { provider: string; label: string } | null {
  const injected = CONTEXT_MODE_PROVIDERS.find((candidate) => candidate.platform === platform);
  if (injected) return injected;
  return IN_PROCESS_PROVIDERS.find((candidate) => candidate.agent === platform) ?? null;
}
