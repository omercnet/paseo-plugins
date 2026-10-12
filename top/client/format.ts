import type { PluginTheme } from "@getpaseo/plugin";

export type Level = "ok" | "warn" | "hot";

export function loadLevel(percent: number | null): Level {
  if (percent === null) return "ok";
  if (percent >= 90) return "hot";
  return percent >= 70 ? "warn" : "ok";
}

export function formatPercent(percent: number | null): string {
  return percent === null ? "--" : `${Math.round(percent)}%`;
}

/**
 * Scales to the largest unit that keeps the number short, with one decimal below ten. Rounding can
 * carry a value over the next unit (1023.6K is 1.0M, not 1024K), so a unit is promoted on the
 * rounded number.
 */
function scaled(value: number, base: number, units: readonly string[]): string {
  let unit = 0;
  let result = value;
  while (Math.round(result) >= base && unit < units.length - 1) {
    result /= base;
    unit++;
  }
  const decimal = unit > 0 && Math.round(result * 10) / 10 < 10;
  return `${decimal ? result.toFixed(1) : Math.round(result)}${units[unit]}`;
}

/** Short throughput such as `0/s`, `850/s`, `12K/s`, `1.5G/s`. */
export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "--" : `${scaled(bytesPerSecond, 1000, ["", "K", "M", "G"])}/s`;
}

/** CPU in cores, such as `0.3 cores` or `12 cores`. */
export function formatCores(cores: number): string {
  return `${Math.round(cores * 10) / 10 < 10 ? cores.toFixed(1) : Math.round(cores)} cores`;
}

/** Short size such as `0B`, `850B`, `12M`, `2.5G`. */
export function formatBytes(bytes: number): string {
  return scaled(bytes, 1024, ["B", "K", "M", "G", "T"]);
}

export function levelColor(theme: PluginTheme, percent: number | null): string {
  const level = loadLevel(percent);
  if (level === "hot") return theme.colors.statusDanger;
  return level === "warn" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
}

/** Like `levelColor`, but a healthy value is green; for dials that should look alive. */
export function zoneColor(theme: PluginTheme, percent: number): string {
  const color = levelColor(theme, percent);
  return color === theme.colors.foregroundMuted ? theme.colors.statusSuccess : color;
}
