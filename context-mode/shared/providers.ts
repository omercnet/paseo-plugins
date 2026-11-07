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

/** The Paseo provider that owns a Context Mode agent id recorded in a database, if any. */
export function providerForPlatform(platform: string): ProviderEntry | null {
  return CONTEXT_MODE_PROVIDERS.find((candidate) => candidate.platform === platform) ?? null;
}
