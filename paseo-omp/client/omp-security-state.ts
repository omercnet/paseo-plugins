import { OMP_SECURITY_SEVERITIES, type OmpSecurityScan } from "../shared/omp-security";

/** The per-severity counts of one scan, worded for both a cut-short list and a failed read. */
export function severityText(scan: OmpSecurityScan): string {
  if (scan.findingCount === 0) return "No findings";
  const listed = OMP_SECURITY_SEVERITIES.flatMap((level) =>
    scan.severities[level] ? [`${scan.severities[level]} ${level}`] : [],
  ).join(", ");
  if (scan.severitiesComplete) return listed;
  return listed === "" ? "Severity counts unavailable" : `${listed} (counts may be incomplete)`;
}
