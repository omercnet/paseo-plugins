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
    pr: params.pr?.toLowerCase() || null,
  };
}

export const VIEWER_URL_LIMIT = 200;
export const DIRECTORY_PARTIAL = "Directory pagination limit reached; results are partial.";
export const LOOKUP_CAPPED = "Viewer lookup is limited to 200 linked pull requests.";

/** Reasons the queue may be incomplete. Any entry makes the sidebar count a lower bound ("N+"). */
export function radarWarnings(input: {
  directoryError: boolean;
  directoryTruncated: boolean;
  workspaceWarnings: number;
  viewerKnown: boolean;
  viewerTruncated: boolean;
  urlCount: number;
}) {
  const warnings: string[] = [];
  if (input.directoryError) warnings.push("Could not load the delivery queue.");
  if (input.directoryTruncated) warnings.push(DIRECTORY_PARTIAL);
  if (input.workspaceWarnings > 0)
    warnings.push("Some workspaces have unavailable pull request status.");
  if (!input.viewerKnown)
    warnings.push("GitHub viewer identity is unavailable. Action buckets are conservative.");
  if (input.urlCount > VIEWER_URL_LIMIT) warnings.push(LOOKUP_CAPPED);
  if (input.viewerTruncated) warnings.push("Results reached the 100-item inbox cap.");
  return warnings;
}

export function needsYouSummary(
  rows: readonly RadarRow[],
  loading: boolean,
  warnings: readonly string[],
) {
  const items = rows.filter((row) => row.bucket === "needs-you");
  return { items, label: loading ? "…" : `${items.length}${warnings.length ? "+" : ""}` };
}
