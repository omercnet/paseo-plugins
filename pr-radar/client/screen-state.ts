import { BUCKETS, type RadarBucket, type RadarRow } from "./radar";

export type RadarFilter = RadarBucket | "active" | "security" | "updated" | "stale" | "automation";
const FILTERS: readonly string[] = [
  ...BUCKETS,
  "active",
  "security",
  "updated",
  "stale",
  "automation",
];

export function parseRadarParams(params: Record<string, string>) {
  return {
    filter: FILTERS.includes(params.filter) ? (params.filter as RadarFilter) : null,
    pr: params.pr || null,
  };
}

export function needsYouSummary(
  rows: readonly RadarRow[],
  loading: boolean,
  warnings: readonly string[],
) {
  const items = rows.filter((row) => row.bucket === "needs-you");
  return { items, label: loading ? "…" : `${items.length}${warnings.length ? "+" : ""}` };
}

export function supportsRadarScreen(
  client: { addScreen?: unknown; addSidebarHeaderItem?: unknown; openScreen?: unknown },
  sidebarRow: unknown,
) {
  return (
    typeof client.addScreen === "function" &&
    typeof client.addSidebarHeaderItem === "function" &&
    typeof client.openScreen === "function" &&
    typeof sidebarRow === "function"
  );
}
