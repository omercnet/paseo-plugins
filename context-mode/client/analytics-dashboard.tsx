import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { getContextModeAnalyticsDashboard } from "../shared/analytics";

const integerFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: "compact",
});
const percentFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${formatInteger(value)} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(1)} GB`;
}

function formatDate(value: string, includeTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return includeTime ? timestampFormatter.format(date) : dateFormatter.format(date);
}

function warningText(warning: unknown): string {
  if (typeof warning === "string") return warning;
  if (!warning || typeof warning !== "object") return String(warning);
  const record = warning as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : null;
  const code = typeof record.code === "string" ? record.code : null;
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  return JSON.stringify(warning) ?? String(warning);
}

function optionalFallback(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const fallback =
    record.raw ?? record.fallback ?? record.rawReport ?? record.fallbackReport ?? null;
  if (typeof fallback === "string") return fallback.trim() || null;
  if (fallback === null || fallback === undefined) return null;
  try {
    return JSON.stringify(fallback, null, 2) ?? String(fallback);
  } catch {
    return String(fallback);
  }
}
interface AnalyticsDashboardProps extends Pick<PluginSurfaceProps, "theme" | "host" | "layout"> {
  fallback?: string | null;
  health?: ReactNode;
  display?: "full" | "hero" | "details";
}
export function AnalyticsDashboard({
  theme,
  host,
  layout,
  fallback,
  health,
  display = "full",
}: AnalyticsDashboardProps) {
  const showHero = display !== "details";
  const showDetails = display !== "hero";
  const loadDashboard = useRpc(getContextModeAnalyticsDashboard);
  const [rawExpanded, setRawExpanded] = useState(false);
  const [sourceLimit, setSourceLimit] = useState(20);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [warningsExpanded, setWarningsExpanded] = useState(false);
  const [dayLimit, setDayLimit] = useState(14);
  const dashboard = useQuery({
    queryKey: ["context-mode", host.id, "analytics-dashboard"],
    queryFn: () => loadDashboard({}),
  });
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 12 : 16 },
      centered: {
        minHeight: 180,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 10,
      },
      section: { gap: 8 },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: 15,
        fontWeight: "700" as const,
      },
      grow: { flex: 1 },
      card: {
        gap: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        padding: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface1,
      },
      hero: {
        gap: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 14,
        padding: layout.compact ? 14 : 20,
        backgroundColor: theme.colors.surface1,
      },
      eyebrow: {
        color: theme.colors.accent,
        fontSize: 11,
        fontWeight: "700" as const,
        letterSpacing: 0.7,
        textTransform: "uppercase" as const,
      },
      headline: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 28 : 36,
        fontWeight: "800" as const,
        lineHeight: layout.compact ? 32 : 40,
      },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      metricGrid: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      metric: {
        minWidth: layout.compact ? 110 : 138,
        flexBasis: layout.compact ? 110 : 138,
        flexGrow: 1,
        gap: 2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        paddingHorizontal: 11,
        paddingVertical: 9,
        backgroundColor: theme.colors.surface1,
      },
      metricValue: {
        color: theme.colors.foreground,
        fontSize: 18,
        fontWeight: "700" as const,
      },
      label: { color: theme.colors.foregroundMuted, fontSize: 11 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      listRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 30,
      },
      rowTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      rowValue: { color: theme.colors.foreground, fontSize: 12 },
      divider: { height: 1, backgroundColor: theme.colors.border },
      badge: {
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: { fontSize: 11, fontWeight: "700" as const },
      success: { color: theme.colors.statusSuccess },
      warning: { color: theme.colors.statusWarning },
      danger: { color: theme.colors.statusDanger },
      warningCard: {
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        borderRadius: 10,
        padding: 11,
        backgroundColor: theme.colors.surface1,
      },
      timelineRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 9,
        minHeight: 30,
      },
      timelineDate: { color: theme.colors.foregroundMuted, fontSize: 11, width: 48 },
      timelineTrack: {
        flex: 1,
        height: 7,
        borderRadius: 999,
        overflow: "hidden" as const,
        backgroundColor: theme.colors.surface2,
      },
      timelineFill: {
        height: "100%" as const,
        minWidth: 2,
        borderRadius: 999,
        backgroundColor: theme.colors.accent,
      },
      timelineValue: {
        color: theme.colors.foreground,
        fontSize: 11,
        width: layout.compact ? 58 : 76,
        textAlign: "right" as const,
      },
      sourceMeta: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        textAlign: "right" as const,
      },
      button: {
        minHeight: 36,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface2,
      },
      buttonText: { color: theme.colors.foreground, fontWeight: "600" as const },
      raw: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: layout.compact ? 10 : 11,
        lineHeight: layout.compact ? 15 : 17,
      },
    }),
    [layout.compact, theme],
  );
  if (dashboard.isPending) {
    return (
      <View style={styles.root}>
        {showHero ? health : null}
        <View
          accessible
          accessibilityLabel="Loading lifetime Context Mode analytics"
          style={styles.centered}
        >
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.subtitle}>Loading lifetime impact…</Text>
        </View>
      </View>
    );
  }

  if (dashboard.error || !dashboard.data) {
    const message = dashboard.error
      ? dashboard.error instanceof Error
        ? dashboard.error.message
        : String(dashboard.error)
      : "Context Mode returned no analytics data.";
    return (
      <View style={styles.root}>
        {showHero ? health : null}
        <View style={styles.card}>
          <Text accessibilityRole="alert" style={styles.danger}>
            {message}
          </Text>
          <Pressable
            accessibilityLabel="Retry loading Context Mode analytics"
            accessibilityRole="button"
            disabled={dashboard.isFetching}
            onPress={() => dashboard.refetch()}
            style={styles.button}
          >
            <Text style={styles.buttonText}>
              {dashboard.isFetching ? "Retrying…" : "Try again"}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const data = dashboard.data;
  const visibleDays = data.byDay.slice(-dayLimit).reverse();
  const maxDailySavings = Math.max(1, ...visibleDays.map((day) => day.savedTokens));
  const rawFallback = fallback?.trim() || optionalFallback(data);
  const isEmpty =
    data.totals.sessions === 0 &&
    data.totals.toolCalls === 0 &&
    data.byProvider.length === 0 &&
    data.byCategory.length === 0 &&
    data.byDay.length === 0 &&
    data.sources.length === 0;
  const visibleSources = data.sources.slice(0, sourceLimit);
  const completenessLabel =
    data.completeness === "complete"
      ? "Complete"
      : data.completeness === "partial"
        ? "Partial"
        : "Unsupported";
  const completenessStyle =
    data.completeness === "complete"
      ? styles.success
      : data.completeness === "partial"
        ? styles.warning
        : styles.danger;

  return (
    <View style={styles.root}>
      {showHero ? (
        <>
          <View
            accessible
            accessibilityLabel={`${formatInteger(data.totals.savedTokens)} lifetime tokens saved, ${percentFormatter.format(data.totals.savingsPercent)} percent reduction`}
            style={styles.hero}
          >
            <View style={styles.row}>
              <Text style={styles.eyebrow}>Lifetime impact</Text>
              <View style={styles.grow} />
              {data.completeness === "complete" ? null : (
                <View style={styles.badge}>
                  <Text style={[styles.badgeText, completenessStyle]}>{completenessLabel}</Text>
                </View>
              )}
            </View>
            <Text style={styles.headline}>{formatCompact(data.totals.savedTokens)}</Text>
            <Text style={styles.sectionTitle}>tokens saved</Text>
            <Text style={styles.subtitle}>
              {percentFormatter.format(data.totals.savingsPercent)}% less context returned across{" "}
              {formatInteger(data.totals.sessions)} sessions
            </Text>
          </View>

          {health}

          {data.completeness !== "complete" || data.warnings.length > 0 ? (
            <View accessibilityRole="alert" style={styles.warningCard}>
              <View style={styles.row}>
                <Text style={[styles.rowTitle, completenessStyle]}>
                  {data.completeness === "unsupported"
                    ? "Analytics unavailable"
                    : data.completeness === "partial"
                      ? "Some analytics are partial"
                      : "Analytics notice"}
                </Text>
                <View style={styles.grow} />
                {data.warnings.length > 0 ? (
                  <Pressable
                    accessibilityLabel={
                      warningsExpanded ? "Hide analytics warnings" : "Show analytics warnings"
                    }
                    accessibilityRole="button"
                    accessibilityState={{ expanded: warningsExpanded }}
                    onPress={() => setWarningsExpanded((expanded) => !expanded)}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>
                      {warningsExpanded ? "Hide" : `${data.warnings.length} details`}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {warningsExpanded
                ? data.warnings.map((warning) => {
                    const text = warningText(warning);
                    return (
                      <Text
                        key={`${warning.code}:${warning.provider ?? ""}:${warning.database ?? ""}:${warning.message}`}
                        style={styles.subtitle}
                      >
                        {text}
                      </Text>
                    );
                  })
                : null}
            </View>
          ) : null}
        </>
      ) : null}

      {showDetails ? (
        isEmpty ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>
              {data.completeness === "unsupported" ? "Analytics unavailable" : "No activity yet"}
            </Text>
            <Text style={styles.subtitle}>
              {data.completeness === "unsupported"
                ? "Update Context Mode to a supported analytics schema to populate this dashboard."
                : "Lifetime metrics will appear after Context Mode records tool activity or indexes a source."}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>At a glance</Text>
              <View style={styles.metricGrid}>
                <Metric
                  label="Providers"
                  value={formatInteger(data.totals.providers)}
                  styles={styles}
                />
                <Metric
                  label="Sessions"
                  value={formatInteger(data.totals.sessions)}
                  styles={styles}
                />
                <Metric
                  label="Tool calls"
                  value={formatInteger(data.totals.toolCalls)}
                  styles={styles}
                />
                <Metric
                  label="Indexed sources"
                  value={formatInteger(data.totals.indexedSources)}
                  styles={styles}
                />
              </View>
              <Pressable
                accessibilityLabel={
                  detailsExpanded ? "Hide analytics details" : "Show analytics details"
                }
                accessibilityRole="button"
                accessibilityState={{ expanded: detailsExpanded }}
                onPress={() => setDetailsExpanded((expanded) => !expanded)}
                style={styles.button}
              >
                <Text style={styles.buttonText}>
                  {detailsExpanded ? "Hide detail" : "More detail"}
                </Text>
              </Pressable>
              {detailsExpanded ? (
                <>
                  <View style={styles.metricGrid}>
                    <Metric
                      label="Databases"
                      value={formatInteger(data.totals.databases)}
                      styles={styles}
                    />
                    <Metric
                      label="Projects"
                      value={formatInteger(data.totals.projects)}
                      styles={styles}
                    />
                    <Metric
                      label="Events"
                      value={formatInteger(data.totals.events)}
                      styles={styles}
                    />
                    <Metric
                      label="Input tokens"
                      value={formatCompact(data.totals.inputTokens)}
                      styles={styles}
                    />
                    <Metric
                      label="Output tokens"
                      value={formatCompact(data.totals.outputTokens)}
                      styles={styles}
                    />
                    <Metric
                      label="Indexed chunks"
                      value={formatInteger(data.totals.indexedChunks)}
                      styles={styles}
                    />
                  </View>
                  <View style={styles.card}>
                    <Text style={styles.rowTitle}>Byte accounting</Text>
                    <Text style={styles.subtitle}>
                      {formatBytes(data.totals.byteAccounting.savedBytes)} saved ·{" "}
                      {formatBytes(data.totals.byteAccounting.returnedBytes)} returned ·{" "}
                      {formatBytes(data.totals.byteAccounting.avoidedBytes)} avoided
                    </Text>
                    <Text style={styles.label}>
                      {formatBytes(data.totals.byteAccounting.eventDataBytes)} event data ·{" "}
                      {formatBytes(data.totals.byteAccounting.snapshotBytes)} snapshots ·{" "}
                      {formatBytes(data.totals.byteAccounting.indexedBytes)} indexed
                    </Text>
                  </View>
                </>
              ) : null}
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Savings over time</Text>
              <View style={styles.card}>
                {data.byDay.length === 0 ? (
                  <Text style={styles.subtitle}>No dated activity is available.</Text>
                ) : (
                  visibleDays.map((day) => {
                    const formattedDate = formatDate(day.date);
                    const width =
                      `${Math.max(2, Math.round((day.savedTokens / maxDailySavings) * 100))}%` as `${number}%`;
                    return (
                      <View
                        accessible
                        accessibilityLabel={`${formattedDate}: ${formatInteger(day.calls)} calls, ${formatInteger(day.savedTokens)} tokens saved`}
                        key={day.date}
                        style={styles.timelineRow}
                      >
                        <Text style={styles.timelineDate}>{formattedDate}</Text>
                        <View style={styles.timelineTrack}>
                          <View style={[styles.timelineFill, { width }]} />
                        </View>
                        <Text style={styles.timelineValue}>{formatCompact(day.savedTokens)}</Text>
                      </View>
                    );
                  })
                )}
                {data.byDay.length > visibleDays.length ? (
                  <Pressable
                    accessibilityLabel={`Show more savings history, ${data.byDay.length - visibleDays.length} days remaining`}
                    accessibilityRole="button"
                    onPress={() =>
                      setDayLimit((current) => Math.min(data.byDay.length, current + 30))
                    }
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Show more history</Text>
                  </Pressable>
                ) : dayLimit > 14 && data.byDay.length > 14 ? (
                  <Pressable
                    accessibilityLabel="Show recent savings history only"
                    accessibilityRole="button"
                    onPress={() => setDayLimit(14)}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Show recent 14 days</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Providers</Text>
              <View style={styles.card}>
                {data.byProvider.length === 0 ? (
                  <Text style={styles.subtitle}>No provider-attributed activity is available.</Text>
                ) : (
                  data.byProvider.map((provider, index) => (
                    <View key={provider.provider}>
                      {index > 0 ? <View style={styles.divider} /> : null}
                      <View
                        accessible
                        accessibilityLabel={`${provider.provider}: ${formatInteger(provider.projects)} projects, ${formatInteger(provider.sessions)} sessions, ${formatInteger(provider.toolCalls)} tool calls, ${formatInteger(provider.savedTokens)} tokens saved, ${percentFormatter.format(provider.savingsPercent)} percent reduction`}
                        style={styles.listRow}
                      >
                        <View style={styles.grow}>
                          <Text style={styles.rowTitle}>{provider.provider}</Text>
                          <Text style={styles.label}>
                            {formatInteger(provider.projects)} projects ·{" "}
                            {formatInteger(provider.sessions)} sessions ·{" "}
                            {formatInteger(provider.toolCalls)} calls
                          </Text>
                        </View>
                        <View>
                          <Text style={styles.rowValue}>
                            {formatCompact(provider.savedTokens)} saved
                          </Text>
                          <Text style={styles.sourceMeta}>
                            {percentFormatter.format(provider.savingsPercent)}% reduction
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))
                )}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Where savings come from</Text>
              <View style={styles.card}>
                {data.byCategory.length === 0 ? (
                  <Text style={styles.subtitle}>No category breakdown is available.</Text>
                ) : (
                  data.byCategory.map((category, index) => (
                    <View key={category.category}>
                      {index > 0 ? <View style={styles.divider} /> : null}
                      <View
                        accessible
                        accessibilityLabel={`${category.category}: ${formatInteger(category.count)} events, ${formatInteger(category.savedTokens)} tokens saved`}
                        style={styles.listRow}
                      >
                        <Text style={[styles.rowTitle, styles.grow]}>{category.category}</Text>
                        <Text style={styles.label}>{formatInteger(category.count)} events</Text>
                        <Text style={styles.rowValue}>
                          {formatCompact(category.savedTokens)} saved
                        </Text>
                      </View>
                    </View>
                  ))
                )}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Knowledge sources</Text>
              <View style={styles.card}>
                {data.sources.length === 0 ? (
                  <Text style={styles.subtitle}>No indexed sources were found.</Text>
                ) : (
                  visibleSources.map((source, index) => {
                    const stateStyle =
                      source.state === "ready"
                        ? styles.success
                        : source.state === "empty"
                          ? styles.warning
                          : styles.danger;
                    return (
                      <View key={`${source.provider}:${source.source}`}>
                        {index > 0 ? <View style={styles.divider} /> : null}
                        <View
                          accessible
                          accessibilityLabel={`${source.source} from ${source.provider}: ${formatInteger(source.chunks)} chunks, ${formatInteger(source.codeChunks)} code chunks, ${source.state}`}
                          style={styles.listRow}
                        >
                          <View style={styles.grow}>
                            <Text style={styles.rowTitle}>{source.source}</Text>
                            <Text style={styles.label}>
                              {source.provider} · {formatBytes(source.indexedBytes)}
                              {source.indexedAt ? ` · ${formatDate(source.indexedAt, true)}` : ""}
                            </Text>
                            {source.detail ? (
                              <Text style={styles.label}>{source.detail}</Text>
                            ) : null}
                          </View>
                          <View>
                            <Text style={[styles.badgeText, stateStyle]}>{source.state}</Text>
                            <Text style={styles.sourceMeta}>
                              {formatInteger(source.chunks)} chunks ·{" "}
                              {formatInteger(source.codeChunks)} code
                            </Text>
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
                {data.sources.length > visibleSources.length ? (
                  <Pressable
                    accessibilityLabel={`Show more indexed sources, ${data.sources.length - visibleSources.length} remaining`}
                    accessibilityRole="button"
                    onPress={() =>
                      setSourceLimit((current) => Math.min(data.sources.length, current + 100))
                    }
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>
                      Show next {Math.min(100, data.sources.length - visibleSources.length)} sources
                    </Text>
                  </Pressable>
                ) : sourceLimit > 20 && data.sources.length > 20 ? (
                  <Pressable
                    accessibilityLabel="Collapse indexed sources"
                    accessibilityRole="button"
                    onPress={() => setSourceLimit(20)}
                    style={styles.button}
                  >
                    <Text style={styles.buttonText}>Show first 20 sources</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </>
        )
      ) : null}

      {showDetails && rawFallback ? (
        <View style={styles.section}>
          <Pressable
            accessibilityLabel={`${rawExpanded ? "Hide" : "Show"} raw analytics fallback`}
            accessibilityRole="button"
            accessibilityState={{ expanded: rawExpanded }}
            onPress={() => setRawExpanded((expanded) => !expanded)}
            style={styles.button}
          >
            <Text style={styles.buttonText}>
              {rawExpanded ? "Hide raw fallback" : "Show raw fallback"}
            </Text>
          </Pressable>
          {rawExpanded ? (
            <View style={styles.card}>
              <Text selectable style={styles.raw}>
                {rawFallback}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Metric({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: {
    metric: object;
    metricValue: object;
    label: object;
  };
}) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}
