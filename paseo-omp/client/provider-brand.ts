import type { PluginIcon } from "@getpaseo/plugin/client";
import antigravitySvg from "../shared/provider-icons/antigravity.svg";
import claudeSvg from "../shared/provider-icons/claude.svg";
import codexSvg from "../shared/provider-icons/codex.svg";
import copilotSvg from "../shared/provider-icons/copilot.svg";
import grokSvg from "../shared/provider-icons/grok.svg";

// Paseo's provider brand icons are host-internal: a host icon name such as "claude" fails button
// validation and draws nothing through `Icon`. The same marks ship here as inline SVG that paints
// with `currentColor`, so the host tints them like any icon; other providers use Lucide.
const BRAND_ICONS: Record<string, PluginIcon> = {
  anthropic: { svg: claudeSvg },
  "antigravity-cli": { svg: antigravitySvg },
  "github-copilot": { svg: copilotSvg },
  "google-antigravity": { svg: antigravitySvg },
  openai: { svg: codexSvg },
  "openai-codex": { svg: codexSvg },
  xai: { svg: grokSvg },
  "xai-oauth": { svg: grokSvg },
};

const LUCIDE_ICONS: Record<string, string> = {
  azure: "Cloud",
  cursor: "MousePointer2",
};

/** The provider's brand mark when known, else the Lucide icon closest to it, else a gauge. */
export function providerIcon(provider: string | null): PluginIcon {
  if (!provider) return "Gauge";
  return BRAND_ICONS[provider] ?? LUCIDE_ICONS[provider] ?? "Gauge";
}
