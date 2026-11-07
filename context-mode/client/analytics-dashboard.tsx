import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import {
  type AnalyticsDashboard as AnalyticsDashboardData,
  type AnalyticsWarning,
  type DailyAnalytics,
  getContextModeAnalyticsDashboard,
  type IndexedSourceAnalytics,
  type SessionAnalytics,
} from "../shared/analytics";
import { type ResumeSessionInput, resumeContextModeSession } from "../shared/knowledge";
import { ActionButton, Card, ErrorText, Pending, StatusPill, type StatusTone } from "./controls";
import {
  ForgetSessionButton,
  ForgetSourceButton,
  presentKnowledgeOutput,
} from "./knowledge-section";

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

const DEFAULT_DAY_LIMIT = 14;
const DEFAULT_SOURCE_LIMIT = 20;

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

type Completeness = AnalyticsDashboardData["completeness"];

interface CompletenessPresentation {
  label: string;
  tone: StatusTone;
  notice: string;
}

const COMPLETENESS: Record<Completeness, CompletenessPresentation> = {
  complete: { label: "Complete", tone: "success", notice: "Analytics notice" },
  partial: { label: "Partial", tone: "warning", notice: "Some analytics are partial" },
  unsupported: { label: "Unsupported", tone: "danger", notice: "Analytics unavailable" },
};

function createStyles(theme: PluginTheme, compact: boolean) {
  return {
    root: { gap: 16 },
    grow: { flex: 1 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    headline: {
      color: theme.colors.foreground,
      fontSize: compact ? 28 : 36,
      fontWeight: "500" as const,
      lineHeight: compact ? 32 : 40,
    },
    caption: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" as const },
    emphasis: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" as const },
    subtitle: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
    metricGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    metric: {
      minWidth: compact ? 112 : 136,
      flexBasis: compact ? 112 : 136,
      flexGrow: 1,
      gap: 4,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: theme.colors.surface1,
    },
    metricValue: { color: theme.colors.foreground, fontSize: 18, fontWeight: "500" as const },
    label: { color: theme.colors.foregroundMuted, fontSize: 12 },
    listRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: 32,
    },
    rowTitle: { color: theme.colors.foreground, fontSize: 13 },
    rowValue: { color: theme.colors.foreground, fontSize: 12 },
    divider: { height: 1, backgroundColor: theme.colors.border },
    timelineDate: { color: theme.colors.foregroundMuted, fontSize: 12, width: 48 },
    timelineTrack: {
      flex: 1,
      height: 8,
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
      fontSize: 12,
      width: compact ? 56 : 76,
      textAlign: "right" as const,
    },
    stack: { gap: 8 },
    meta: { color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "right" as const },
    raw: {
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: 12,
      lineHeight: 16,
    },
  };
}

type DashboardStyles = ReturnType<typeof createStyles>;

interface AnalyticsDashboardProps extends Pick<PluginSurfaceProps, "theme" | "host" | "layout"> {
  health?: ReactNode;
  display?: "full" | "hero" | "details";
}

export function AnalyticsDashboard({
  theme,
  host,
  layout,
  health,
  display = "full",
}: AnalyticsDashboardProps) {
  const showHero = display !== "details";
  const showDetails = display !== "hero";
  const loadDashboard = useRpc(getContextModeAnalyticsDashboard);
  const dashboard = useQuery({
    queryKey: ["context-mode", host.id, "analytics-dashboard"],
    queryFn: () => loadDashboard({}),
  });
  const styles = createStyles(theme, layout.compact);
  const heroHealth = showHero ? health : null;

  if (dashboard.isPending) {
    return (
      <View style={styles.root}>
        {heroHealth}
        <Pending theme={theme} label="Loading lifetime impact..." />
      </View>
    );
  }

  if (dashboard.isError) {
    return (
      <View style={styles.root}>
        {heroHealth}
        <Card theme={theme}>
          <ErrorText theme={theme} error={dashboard.error} />
          <ActionButton
            theme={theme}
            accessibilityLabel="Retry loading Context Mode analytics"
            disabled={dashboard.isFetching}
            label={dashboard.isFetching ? "Retrying..." : "Try again"}
            onPress={() => void dashboard.refetch()}
          />
        </Card>
      </View>
    );
  }

  const data = dashboard.data;
  return (
    <View style={styles.root}>
      {showHero ? <Hero data={data} health={health} styles={styles} theme={theme} /> : null}
      {showDetails ? (
        <DashboardDetails data={data} host={host} styles={styles} theme={theme} />
      ) : null}
    </View>
  );
}

interface DashboardPartProps {
  data: AnalyticsDashboardData;
  styles: DashboardStyles;
  theme: PluginTheme;
}

interface HeroProps extends DashboardPartProps {
  health: ReactNode;
}

function Hero({ data, health, styles, theme }: HeroProps) {
  const completeness = COMPLETENESS[data.completeness];
  const savedPercent = percentFormatter.format(data.totals.savingsPercent);
  const showNotice = data.completeness !== "complete" || data.warnings.length > 0;
  return (
    <>
      <View
        accessible
        accessibilityLabel={`${formatInteger(data.totals.savedTokens)} lifetime tokens saved, ${savedPercent} percent reduction`}
      >
        <Card theme={theme}>
          <View style={styles.row}>
            <Text style={[styles.caption, styles.grow]}>Lifetime impact</Text>
            {data.completeness === "complete" ? null : (
              <StatusPill theme={theme} label={completeness.label} tone={completeness.tone} />
            )}
          </View>
          <View style={{ gap: 4 }}>
            <Text style={styles.headline}>{formatCompact(data.totals.savedTokens)}</Text>
            <Text style={styles.emphasis}>tokens saved</Text>
            <Text style={styles.subtitle}>
              {savedPercent}% less context returned across {formatInteger(data.totals.sessions)}{" "}
              sessions
            </Text>
          </View>
        </Card>
      </View>
      {health}
      {showNotice ? <AnalyticsNotice data={data} styles={styles} theme={theme} /> : null}
    </>
  );
}

function AnalyticsNotice({ data, styles, theme }: DashboardPartProps) {
  const [expanded, setExpanded] = useState(false);
  const completeness = COMPLETENESS[data.completeness];
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        borderRadius: 8,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={styles.row}>
        <Text style={[styles.rowTitle, styles.grow]}>{completeness.notice}</Text>
        {data.warnings.length > 0 ? (
          <ActionButton
            theme={theme}
            variant="outline"
            expanded={expanded}
            accessibilityLabel={expanded ? "Hide analytics warnings" : "Show analytics warnings"}
            label={expanded ? "Hide" : `${data.warnings.length} details`}
            onPress={() => setExpanded((value) => !value)}
          />
        ) : null}
      </View>
      {expanded
        ? data.warnings.map((warning) => (
            <WarningLine
              key={`${warning.code}:${warning.project ?? ""}:${warning.message}`}
              warning={warning}
              styles={styles}
            />
          ))
        : null}
    </View>
  );
}

interface WarningLineProps {
  warning: AnalyticsWarning;
  styles: DashboardStyles;
}

function WarningLine({ warning, styles }: WarningLineProps) {
  return <Text style={styles.subtitle}>{`${warning.code}: ${warning.message}`}</Text>;
}

interface DashboardDetailsProps extends DashboardPartProps {
  host: PluginSurfaceProps["host"];
}

function isEmptyDashboard(data: AnalyticsDashboardData): boolean {
  const noTotals = data.totals.sessions === 0 && data.totals.toolCalls === 0;
  const noBreakdowns =
    data.byAgent.length === 0 &&
    data.byProject.length === 0 &&
    data.byCategory.length === 0 &&
    data.byDay.length === 0;
  const noLists = data.sources.length === 0 && data.recentSessions.length === 0;
  return noTotals && noBreakdowns && noLists;
}

function DashboardDetails({ data, host, styles, theme }: DashboardDetailsProps) {
  if (isEmptyDashboard(data)) {
    const unsupported = data.completeness === "unsupported";
    const title = unsupported ? "Analytics unavailable" : "No activity yet";
    const hint = unsupported
      ? "Update Context Mode to a supported analytics schema to populate this dashboard."
      : "Lifetime metrics will appear after Context Mode records tool activity or indexes a source.";
    return (
      <Card theme={theme}>
        <Text style={styles.emphasis}>{title}</Text>
        <Text style={styles.subtitle}>{hint}</Text>
      </Card>
    );
  }
  const part = { data, styles, theme };
  return (
    <>
      <AtAGlance {...part} />
      <SavingsOverTime {...part} />
      <AgentBreakdown {...part} />
      <ProjectBreakdown {...part} />
      {data.recentSessions.length > 0 ? <RecentSessions {...part} host={host} /> : null}
      <CategoryBreakdown {...part} />
      <KnowledgeSources {...part} host={host} />
    </>
  );
}

function AtAGlance({ data, styles, theme }: DashboardPartProps) {
  const [expanded, setExpanded] = useState(false);
  const { totals } = data;
  return (
    <SettingsSection title="At a glance">
      <View style={styles.stack}>
        <View style={styles.metricGrid}>
          <Metric label="Agents" value={formatInteger(totals.agents)} styles={styles} />
          <Metric label="Sessions" value={formatInteger(totals.sessions)} styles={styles} />
          <Metric label="Tool calls" value={formatInteger(totals.toolCalls)} styles={styles} />
          <Metric
            label="Indexed sources"
            value={formatInteger(totals.indexedSources)}
            styles={styles}
          />
        </View>
        <ActionButton
          theme={theme}
          variant="outline"
          expanded={expanded}
          accessibilityLabel={expanded ? "Hide analytics details" : "Show analytics details"}
          label={expanded ? "Hide detail" : "More detail"}
          onPress={() => setExpanded((value) => !value)}
        />
        {expanded ? <MoreDetail data={data} styles={styles} theme={theme} /> : null}
      </View>
    </SettingsSection>
  );
}

function MoreDetail({ data, styles, theme }: DashboardPartProps) {
  const { totals } = data;
  const bytes = totals.byteAccounting;
  const lastActivity = totals.lastActivityAt ? formatDate(totals.lastActivityAt, true) : "None";
  const version = data.contextModeVersion ? ` · Context Mode ${data.contextModeVersion}` : "";
  return (
    <>
      <View style={styles.metricGrid}>
        <Metric label="Last activity" value={lastActivity} styles={styles} />
        <Metric label="Projects" value={formatInteger(totals.projects)} styles={styles} />
        <Metric label="Events" value={formatInteger(totals.events)} styles={styles} />
        <Metric label="Input tokens" value={formatCompact(totals.inputTokens)} styles={styles} />
        <Metric label="Output tokens" value={formatCompact(totals.outputTokens)} styles={styles} />
        <Metric
          label="Indexed chunks"
          value={formatInteger(totals.indexedChunks)}
          styles={styles}
        />
      </View>
      <Card theme={theme}>
        <Text style={styles.rowTitle}>Byte accounting</Text>
        <Text style={styles.subtitle}>
          {formatBytes(bytes.savedBytes)} saved · {formatBytes(bytes.returnedBytes)} returned ·{" "}
          {formatBytes(bytes.producedBytes)} produced
        </Text>
        <Text style={styles.label}>
          {formatBytes(bytes.indexedBytes)} indexed{version}
        </Text>
      </Card>
    </>
  );
}

interface ShowMoreToggleProps {
  theme: PluginTheme;
  total: number;
  limit: number;
  initialLimit: number;
  step: number;
  onLimitChange(limit: number): void;
  moreLabel(next: number): string;
  moreAccessibilityLabel(remaining: number): string;
  lessLabel: string;
  lessAccessibilityLabel: string;
}

/** Grows a capped list by `step`, then offers to collapse it back once it is fully shown. */
function ShowMoreToggle({
  theme,
  total,
  limit,
  initialLimit,
  step,
  onLimitChange,
  moreLabel,
  moreAccessibilityLabel,
  lessLabel,
  lessAccessibilityLabel,
}: ShowMoreToggleProps) {
  const remaining = total - limit;
  if (remaining > 0) {
    return (
      <ActionButton
        theme={theme}
        variant="outline"
        accessibilityLabel={moreAccessibilityLabel(remaining)}
        label={moreLabel(Math.min(step, remaining))}
        onPress={() => onLimitChange(Math.min(total, limit + step))}
      />
    );
  }
  if (limit > initialLimit && total > initialLimit) {
    return (
      <ActionButton
        theme={theme}
        variant="outline"
        accessibilityLabel={lessAccessibilityLabel}
        label={lessLabel}
        onPress={() => onLimitChange(initialLimit)}
      />
    );
  }
  return null;
}

function SavingsOverTime({ data, styles, theme }: DashboardPartProps) {
  const [dayLimit, setDayLimit] = useState(DEFAULT_DAY_LIMIT);
  const visibleDays = data.byDay.slice(-dayLimit).reverse();
  const dailySavings = visibleDays.map((day) => day.savedTokens);
  const maxDailySavings = Math.max(1, ...dailySavings);
  return (
    <SettingsSection title="Savings over time">
      <Card theme={theme}>
        {data.byDay.length === 0 ? <Text style={styles.subtitle}>No dated activity</Text> : null}
        {visibleDays.map((day) => (
          <DayRow key={day.date} day={day} max={maxDailySavings} styles={styles} />
        ))}
        <ShowMoreToggle
          theme={theme}
          total={data.byDay.length}
          limit={Math.min(dayLimit, data.byDay.length)}
          initialLimit={DEFAULT_DAY_LIMIT}
          step={30}
          onLimitChange={setDayLimit}
          moreLabel={() => "Show more history"}
          moreAccessibilityLabel={(remaining) =>
            `Show more savings history, ${remaining} days remaining`
          }
          lessLabel={`Show recent ${DEFAULT_DAY_LIMIT} days`}
          lessAccessibilityLabel="Show recent savings history only"
        />
      </Card>
    </SettingsSection>
  );
}

interface DayRowProps {
  day: DailyAnalytics;
  max: number;
  styles: DashboardStyles;
}

function DayRow({ day, max, styles }: DayRowProps) {
  const formattedDate = formatDate(day.date);
  const percent = Math.max(2, Math.round((day.savedTokens / max) * 100));
  const width: `${number}%` = `${percent}%`;
  return (
    <View
      accessible
      accessibilityLabel={`${formattedDate}: ${formatInteger(day.calls)} calls, ${formatInteger(day.savedTokens)} tokens saved`}
      style={styles.listRow}
    >
      <Text style={styles.timelineDate}>{formattedDate}</Text>
      <View style={styles.timelineTrack}>
        <View style={[styles.timelineFill, { width }]} />
      </View>
      <Text style={styles.timelineValue}>{formatCompact(day.savedTokens)}</Text>
    </View>
  );
}

interface DividedProps {
  index: number;
  styles: DashboardStyles;
  children: ReactNode;
}

/** A card row; rows after the first carry the divider. */
function Divided({ index, styles, children }: DividedProps) {
  return (
    <View style={styles.stack}>
      {index > 0 ? <View style={styles.divider} /> : null}
      {children}
    </View>
  );
}

function AgentBreakdown({ data, styles, theme }: DashboardPartProps) {
  return (
    <SettingsSection title="Agents">
      <Card theme={theme}>
        {data.byAgent.length === 0 ? <Text style={styles.subtitle}>No agent activity</Text> : null}
        {data.byAgent.map((agent, index) => (
          <Divided key={agent.agent} index={index} styles={styles}>
            <View
              accessible
              accessibilityLabel={`${agent.agent}: ${formatInteger(agent.projects)} projects, ${formatInteger(agent.sessions)} sessions, ${formatInteger(agent.toolCalls)} tool calls, ${formatInteger(agent.savedTokens)} tokens saved, ${percentFormatter.format(agent.savingsPercent)} percent reduction`}
              style={styles.listRow}
            >
              <View style={styles.grow}>
                <Text style={styles.rowTitle}>{agent.agent}</Text>
                <Text style={styles.label}>
                  {formatInteger(agent.projects)} projects · {formatInteger(agent.sessions)}{" "}
                  sessions · {formatInteger(agent.toolCalls)} calls
                </Text>
              </View>
              <SavedValue
                value={`${formatCompact(agent.savedTokens)} saved`}
                percent={agent.savingsPercent}
                styles={styles}
              />
            </View>
          </Divided>
        ))}
      </Card>
    </SettingsSection>
  );
}

interface SavedValueProps {
  value: string;
  percent: number;
  styles: DashboardStyles;
}

function SavedValue({ value, percent, styles }: SavedValueProps) {
  return (
    <View>
      <Text style={styles.rowValue}>{value}</Text>
      <Text style={styles.meta}>{percentFormatter.format(percent)}% reduction</Text>
    </View>
  );
}

function ProjectBreakdown({ data, styles, theme }: DashboardPartProps) {
  const truncated = data.totals.projects > data.byProject.length;
  return (
    <SettingsSection title="Projects">
      <Card theme={theme}>
        {data.byProject.length === 0 ? (
          <Text style={styles.subtitle}>No project activity</Text>
        ) : null}
        {data.byProject.map((project, index) => {
          const worktrees =
            project.worktrees > 1 ? ` · ${formatInteger(project.worktrees)} worktrees` : "";
          return (
            <Divided key={project.path} index={index} styles={styles}>
              <View
                accessible
                accessibilityLabel={`${project.path}: ${formatInteger(project.sessions)} sessions, ${formatInteger(project.toolCalls)} tool calls, ${formatInteger(project.indexedSources)} indexed sources, ${formatInteger(project.savedTokens)} tokens saved`}
                style={styles.listRow}
              >
                <View style={styles.grow}>
                  <Text style={styles.rowTitle}>{project.path}</Text>
                  <Text style={styles.label}>
                    {formatInteger(project.sessions)} sessions · {formatInteger(project.toolCalls)}{" "}
                    calls · {formatInteger(project.indexedSources)} sources{worktrees}
                  </Text>
                </View>
                <SavedValue
                  value={`${formatBytes(project.byteAccounting.savedBytes)} saved`}
                  percent={project.savingsPercent}
                  styles={styles}
                />
              </View>
            </Divided>
          );
        })}
        {truncated ? (
          <Text style={styles.label}>
            Top {formatInteger(data.byProject.length)} of {formatInteger(data.totals.projects)}{" "}
            projects by savings
          </Text>
        ) : null}
      </Card>
    </SettingsSection>
  );
}

interface HostPartProps extends DashboardPartProps {
  host: PluginSurfaceProps["host"];
}

function RecentSessions({ data, host, styles, theme }: HostPartProps) {
  return (
    <SettingsSection title="Recent sessions">
      <Card theme={theme}>
        {data.recentSessions.map((session, index) => (
          <Divided
            key={`${session.agent}:${session.projectPath}:${session.sessionId}`}
            index={index}
            styles={styles}
          >
            <RecentSessionRow host={host} session={session} styles={styles} theme={theme} />
          </Divided>
        ))}
      </Card>
    </SettingsSection>
  );
}

function CategoryBreakdown({ data, styles, theme }: DashboardPartProps) {
  return (
    <SettingsSection title="Where savings come from">
      <Card theme={theme}>
        {data.byCategory.length === 0 ? (
          <Text style={styles.subtitle}>No category breakdown</Text>
        ) : null}
        {data.byCategory.map((category, index) => (
          <Divided key={category.category} index={index} styles={styles}>
            <View
              accessible
              accessibilityLabel={`${category.category}: ${formatInteger(category.count)} events, ${formatInteger(category.savedTokens)} tokens saved`}
              style={styles.listRow}
            >
              <Text style={[styles.rowTitle, styles.grow]}>{category.category}</Text>
              <Text style={styles.label}>{formatInteger(category.count)} calls</Text>
              <Text style={styles.rowValue}>{formatCompact(category.savedTokens)} saved</Text>
            </View>
          </Divided>
        ))}
      </Card>
    </SettingsSection>
  );
}

function KnowledgeSources({ data, host, styles, theme }: HostPartProps) {
  const [sourceLimit, setSourceLimit] = useState(DEFAULT_SOURCE_LIMIT);
  const visibleSources = data.sources.slice(0, sourceLimit);
  return (
    <SettingsSection title="Knowledge sources">
      <Card theme={theme}>
        {data.sources.length === 0 ? <Text style={styles.subtitle}>No indexed sources</Text> : null}
        {visibleSources.map((source, index) => (
          <Divided
            key={`${source.agent}:${source.projectPath}:${source.source}:${source.indexedAt ?? ""}`}
            index={index}
            styles={styles}
          >
            <SourceRow host={host} source={source} styles={styles} theme={theme} />
          </Divided>
        ))}
        <ShowMoreToggle
          theme={theme}
          total={data.sources.length}
          limit={visibleSources.length}
          initialLimit={DEFAULT_SOURCE_LIMIT}
          step={100}
          onLimitChange={setSourceLimit}
          moreLabel={(next) => `Show next ${next} sources`}
          moreAccessibilityLabel={(remaining) =>
            `Show more indexed sources, ${remaining} remaining`
          }
          lessLabel={`Show first ${DEFAULT_SOURCE_LIMIT} sources`}
          lessAccessibilityLabel="Collapse indexed sources"
        />
      </Card>
    </SettingsSection>
  );
}

interface SourceRowProps extends Pick<PluginSurfaceProps, "theme" | "host"> {
  source: IndexedSourceAnalytics;
  styles: DashboardStyles;
}

function SourceRow({ host, source, styles, theme }: SourceRowProps) {
  const indexedAt = source.indexedAt ? ` · ${formatDate(source.indexedAt, true)}` : "";
  return (
    <View style={styles.stack}>
      <View
        accessible
        accessibilityLabel={`${source.source} from ${source.agent} in ${source.projectPath}: ${formatInteger(source.chunks)} chunks, ${source.kind}`}
        style={styles.listRow}
      >
        <View style={styles.grow}>
          <Text numberOfLines={2} style={styles.rowTitle}>
            {source.source}
          </Text>
          <Text style={styles.label}>
            {source.agent} · {formatBytes(source.indexedBytes)}
            {indexedAt}
          </Text>
          <Text style={styles.label}>{source.projectPath}</Text>
        </View>
        <View>
          <Text style={[styles.label, styles.caption]}>{source.kind}</Text>
          <Text style={styles.meta}>{formatInteger(source.chunks)} chunks</Text>
        </View>
      </View>
      {source.provider ? (
        <ForgetSourceButton
          theme={theme}
          host={host}
          provider={source.provider}
          projectPath={source.projectPath}
          source={source.source}
        />
      ) : null}
    </View>
  );
}

interface RecentSessionRowProps extends Pick<PluginSurfaceProps, "theme" | "host"> {
  session: SessionAnalytics;
  styles: DashboardStyles;
}

function RecentSessionRow({ theme, host, session, styles }: RecentSessionRowProps) {
  const lastActivity = session.lastActivityAt
    ? formatDate(session.lastActivityAt, true)
    : "No recorded activity";
  return (
    <View style={styles.stack}>
      <View
        accessible
        accessibilityLabel={`Session ${session.sessionId} from ${session.agent} in ${session.projectPath}: ${formatInteger(session.events)} events, last activity ${lastActivity}`}
        style={styles.listRow}
      >
        <View style={styles.grow}>
          <Text numberOfLines={2} style={styles.rowTitle}>
            {session.projectPath}
          </Text>
          <Text style={styles.label}>
            {session.agent} · {lastActivity}
          </Text>
          <Text selectable style={styles.label}>
            Session {session.sessionId}
          </Text>
        </View>
        <View>
          <Text style={styles.rowValue}>{formatInteger(session.events)}</Text>
          <Text style={styles.meta}>events</Text>
        </View>
      </View>
      {session.provider ? (
        <>
          <ResumeState
            target={{
              provider: session.provider,
              projectPath: session.projectPath,
              sessionId: session.sessionId,
            }}
            styles={styles}
            theme={theme}
          />
          <ForgetSessionButton
            host={host}
            projectPath={session.projectPath}
            provider={session.provider}
            sessionId={session.sessionId}
            theme={theme}
          />
        </>
      ) : null}
    </View>
  );
}

interface ResumeStateProps {
  target: ResumeSessionInput;
  styles: DashboardStyles;
  theme: PluginTheme;
}

/** The `ctx_resume` block an agent would get for this session, loaded on demand. */
function ResumeState({ target, styles, theme }: ResumeStateProps) {
  const resumeSession = useRpc(resumeContextModeSession);
  const [expanded, setExpanded] = useState(false);
  const resume = useMutation({ mutationFn: (input: ResumeSessionInput) => resumeSession(input) });

  function toggle() {
    if (!expanded) resume.mutate(target);
    setExpanded(!expanded);
  }

  return (
    <>
      <ActionButton
        theme={theme}
        variant="outline"
        expanded={expanded}
        accessibilityLabel={`${expanded ? "Hide" : "Show"} resume state for session ${target.sessionId}`}
        label={expanded ? "Hide" : "Resume state"}
        onPress={toggle}
      />
      {expanded && resume.isPending ? <Pending theme={theme} label="Loading..." /> : null}
      {expanded ? <ErrorText theme={theme} error={resume.error} /> : null}
      {expanded && resume.data ? (
        <Text selectable style={styles.raw}>
          {presentKnowledgeOutput(resume.data.output) || "No resume state for this session"}
        </Text>
      ) : null}
    </>
  );
}

interface MetricProps {
  label: string;
  value: string;
  styles: DashboardStyles;
}

function Metric({ label, value, styles }: MetricProps) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}
