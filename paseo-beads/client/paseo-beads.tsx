import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  findNodeHandle,
  InteractionManager,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import {
  type BeadDetail,
  type BeadSummary,
  getWorkspaceBead,
  getWorkspaceBeads,
} from "../shared/beads";
import {
  BEAD_LANE_TITLES,
  BEAD_LANES,
  type BeadLane,
  type BeadSection,
  type BeadsFilter,
  buildBeadSections,
  buildBeadsView,
  issueAccessibilityLabel,
} from "./beads-view";
import { focusWebElement } from "./web";

const REFRESH_INTERVAL_MS = 10_000;
const BACK_BUTTON_NATIVE_ID = "paseo-beads-back";
const ISSUE_ROW_NATIVE_ID_PREFIX = "paseo-beads-issue-";
const ID_FONT_FAMILY = Platform.select({ ios: "Menlo", default: "monospace" });

const FILTERS: readonly { id: BeadsFilter; title: string }[] = [
  { id: "all", title: "All" },
  { id: "high_priority", title: "P0–P1" },
  { id: "assigned", title: "Assigned" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "Unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function countText(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function laneColor(lane: BeadLane, colors: PluginWorkspacePanelProps["theme"]["colors"]): string {
  if (lane === "ready") return colors.statusSuccess;
  if (lane === "in_progress") return colors.accent;
  if (lane === "blocked") return colors.statusDanger;
  return colors.foregroundMuted;
}

function priorityColor(
  priority: number,
  colors: PluginWorkspacePanelProps["theme"]["colors"],
): string {
  if (priority <= 1) return colors.statusDanger;
  if (priority === 2) return colors.statusWarning;
  return colors.foregroundMuted;
}

function readinessLabel(issue: BeadSummary): string {
  if (issue.isReady) return "Ready";
  if (issue.isBlocked) return "Blocked";
  return "Not ready";
}

function readinessColor(
  issue: BeadSummary,
  colors: PluginWorkspacePanelProps["theme"]["colors"],
): string {
  if (issue.isReady) return colors.statusSuccess;
  if (issue.isBlocked) return colors.statusDanger;
  return colors.foregroundMuted;
}

function issueRowNativeId(issueId: string): string {
  return `${ISSUE_ROW_NATIVE_ID_PREFIX}${encodeURIComponent(issueId)}`;
}

function focusAccessibilityTarget(target: View | null, nativeId: string): boolean {
  if (focusWebElement(nativeId)) return true;
  if (Platform.OS === "web") return false;

  const node = target ? findNodeHandle(target) : null;
  if (node === null) return false;

  AccessibilityInfo.setAccessibilityFocus(node);
  return true;
}

type PanelStyles = Record<string, TextStyle | ViewStyle>;

function StateCard({
  body,
  icon,
  loading,
  onRetry,
  styles,
  theme,
  title,
}: {
  body: string;
  icon: string;
  loading?: boolean;
  onRetry?: () => void;
  styles: PanelStyles;
  theme: PluginWorkspacePanelProps["theme"];
  title: string;
}) {
  return (
    <View style={styles.stateCard}>
      {loading ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <Icon name={icon} size={24} color={theme.colors.foregroundMuted} />
      )}
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateBody}>{body}</Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading Beads"
          onPress={onRetry}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryButtonText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TextSection({
  content,
  styles,
  title,
}: {
  content: string | null;
  styles: PanelStyles;
  title: string;
}) {
  return (
    <View style={styles.detailSection}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text selectable style={content?.trim() ? styles.sectionCopy : styles.sectionEmpty}>
        {content?.trim() || "Not provided."}
      </Text>
    </View>
  );
}

function RelationshipList({
  items,
  styles,
}: {
  items: BeadDetail["dependencies"];
  styles: PanelStyles;
}) {
  if (items.length === 0) return <Text style={styles.sectionEmpty}>None.</Text>;

  return (
    <View style={styles.relationshipList}>
      {items.map((item) => (
        <View key={`${item.dependencyType}:${item.id}`} style={styles.relationshipRow}>
          <View style={styles.relationshipHeader}>
            <Text selectable style={styles.relationshipId}>
              {item.id}
            </Text>
            <Text style={styles.relationshipStatus}>{item.status}</Text>
          </View>
          <Text selectable style={styles.relationshipTitle}>
            {item.title}
          </Text>
          <Text style={styles.relationshipMeta}>
            {item.issueType} · {item.dependencyType}
          </Text>
        </View>
      ))}
    </View>
  );
}

function DetailPane({
  detail,
  backButtonRef,
  detailError,
  isDetailFetching,
  isDetailPending,
  missing,
  onBack,
  onRetry,
  selectedId,
  showBack,
  styles,
  theme,
}: {
  backButtonRef: RefObject<View | null>;
  detail: BeadDetail | null | undefined;
  detailError: unknown;
  isDetailFetching: boolean;
  isDetailPending: boolean;
  missing: boolean;
  onBack(): void;
  onRetry(): void;
  selectedId: string | null;
  showBack: boolean;
  styles: PanelStyles;
  theme: PluginWorkspacePanelProps["theme"];
}) {
  if (!selectedId) {
    return (
      <View style={styles.detailEmpty}>
        <Icon name="CircleDot" size={26} color={theme.colors.foregroundMuted} />
        <Text style={styles.stateTitle}>Choose a bead</Text>
        <Text style={styles.stateBody}>
          Select an issue to inspect its dependencies, context, and acceptance criteria.
        </Text>
      </View>
    );
  }

  const backButton = showBack ? (
    <Pressable
      ref={backButtonRef}
      nativeID={BACK_BUTTON_NATIVE_ID}
      accessibilityRole="button"
      accessibilityLabel="Back to Beads list"
      onPress={onBack}
      style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
    >
      <Icon name="ArrowLeft" size={16} color={theme.colors.foreground} />
      <Text style={styles.backText}>Back</Text>
    </Pressable>
  ) : null;

  if (isDetailPending && !detail) {
    return (
      <View style={styles.detailRoot}>
        {backButton}
        <StateCard
          body={`Reading ${selectedId}.`}
          icon="CircleDot"
          loading
          styles={styles}
          theme={theme}
          title="Loading bead"
        />
      </View>
    );
  }

  if (detailError && !detail) {
    return (
      <View style={styles.detailRoot}>
        {backButton}
        <StateCard
          body={errorMessage(detailError)}
          icon="AlertTriangle"
          onRetry={onRetry}
          styles={styles}
          theme={theme}
          title="Could not load this bead"
        />
      </View>
    );
  }

  if (missing || !detail) {
    return (
      <View style={styles.detailRoot}>
        {backButton}
        <StateCard
          body="This issue is no longer available. Refresh the list or choose another bead."
          icon="CircleDot"
          onRetry={onRetry}
          styles={styles}
          theme={theme}
          title="Bead not found"
        />
      </View>
    );
  }

  const linkCount = detail.dependencyCount + detail.dependentCount;

  return (
    <ScrollView
      style={styles.detailScroll}
      contentContainerStyle={styles.detailContent}
      keyboardShouldPersistTaps="handled"
    >
      {backButton}
      <View style={styles.detailHeading}>
        <View style={styles.detailIdRow}>
          <Text selectable style={styles.detailId}>
            {detail.id}
          </Text>
          <View
            style={[styles.readinessBadge, { borderColor: readinessColor(detail, theme.colors) }]}
          >
            <Text style={[styles.readinessText, { color: readinessColor(detail, theme.colors) }]}>
              {readinessLabel(detail)}
            </Text>
          </View>
        </View>
        <Text selectable accessibilityRole="header" style={styles.detailTitle}>
          {detail.title}
        </Text>
        <Text style={styles.detailRefreshState}>
          {isDetailFetching ? "Refreshing detail…" : `Updated ${formatUpdatedAt(detail.updatedAt)}`}
        </Text>
      </View>

      {detailError ? (
        <View accessibilityRole="alert" style={styles.inlineError}>
          <Text style={styles.inlineErrorTitle}>Detail refresh failed</Text>
          <Text style={styles.inlineErrorBody}>{errorMessage(detailError)}</Text>
        </View>
      ) : null}

      <View style={styles.factGrid}>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Status</Text>
          <Text selectable style={styles.factValue}>
            {detail.status}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Priority</Text>
          <Text
            selectable
            style={[styles.factValue, { color: priorityColor(detail.priority, theme.colors) }]}
          >
            P{detail.priority}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Type</Text>
          <Text selectable style={styles.factValue}>
            {detail.issueType}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Assignee</Text>
          <Text selectable style={styles.factValue}>
            {detail.assignee || "Unassigned"}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Parent</Text>
          <Text selectable style={styles.factValue}>
            {detail.parent || "None"}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Activity</Text>
          <Text style={styles.factValue}>
            {countText(linkCount, "relationship")} · {countText(detail.commentCount, "comment")}
          </Text>
        </View>
      </View>

      <View style={styles.detailSection}>
        <Text style={styles.sectionTitle}>Labels</Text>
        {detail.labels.length ? (
          <View style={styles.labelRail}>
            {detail.labels.map((label) => (
              <View key={label} style={styles.labelBadge}>
                <Text selectable style={styles.labelText}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.sectionEmpty}>None.</Text>
        )}
      </View>

      <TextSection title="Description" content={detail.description} styles={styles} />
      <TextSection
        title="Acceptance criteria"
        content={detail.acceptanceCriteria}
        styles={styles}
      />
      <TextSection title="Design" content={detail.design} styles={styles} />
      <TextSection title="Notes" content={detail.notes} styles={styles} />

      <View style={styles.detailSection}>
        <View style={styles.sectionHeadingRow}>
          <Text style={styles.sectionTitle}>Dependencies</Text>
          <Text style={styles.sectionCount}>{detail.dependencies.length}</Text>
        </View>
        <RelationshipList items={detail.dependencies} styles={styles} />
      </View>
      <View style={styles.detailSection}>
        <View style={styles.sectionHeadingRow}>
          <Text style={styles.sectionTitle}>Dependents</Text>
          <Text style={styles.sectionCount}>{detail.dependents.length}</Text>
        </View>
        <RelationshipList items={detail.dependents} styles={styles} />
      </View>
      <View style={styles.detailSection}>
        <Text style={styles.sectionTitle}>Updated</Text>
        <Text selectable style={styles.sectionCopy}>
          {formatUpdatedAt(detail.updatedAt)}
        </Text>
      </View>
    </ScrollView>
  );
}

export function PaseoBeads(props: PluginWorkspacePanelProps) {
  return <WorkspaceBeads key={props.workspaceId} {...props} />;
}

function WorkspaceBeads({ theme, layout, host, workspaceId }: PluginWorkspacePanelProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const workspaceTitle = useWorkspace(workspaceId, ({ name, title }) => title?.trim() || name);
  const loadSnapshot = useRpc(getWorkspaceBeads);
  const loadDetail = useRpc(getWorkspaceBead);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<BeadsFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailFocusRef = useRef<View | null>(null);
  const issueRowRefs = useRef(new Map<string, View>());
  const originatingIssueIdRef = useRef<string | null>(null);
  const pendingFocusIssueIdRef = useRef<string | null>(null);
  const listScrollOffsetRef = useRef(0);

  const snapshotKey = useMemo(
    () => ["paseo-beads", "snapshot", host.id, workspaceId] as const,
    [host.id, workspaceId],
  );
  const {
    data: snapshot,
    error: snapshotError,
    isFetching: isSnapshotFetching,
    isPending: isSnapshotPending,
    refetch: refetchSnapshot,
  } = useQuery({
    queryKey: snapshotKey,
    queryFn: () => loadSnapshot({ workspaceId }),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  const view = useMemo(
    () => buildBeadsView(snapshot?.issues ?? [], { query: search, filter }),
    [filter, search, snapshot?.issues],
  );
  const activeFiltering = filter !== "all" || search.trim().length > 0;
  const sections = useMemo(() => buildBeadSections(view, activeFiltering), [activeFiltering, view]);
  const detailKey = useMemo(
    () => ["paseo-beads", "detail", host.id, workspaceId, selectedId] as const,
    [host.id, selectedId, workspaceId],
  );
  const {
    data: detailResult,
    error: detailError,
    isFetching: isDetailFetching,
    isPending: isDetailPending,
    refetch: refetchDetail,
  } = useQuery({
    queryKey: detailKey,
    queryFn: () => loadDetail({ workspaceId, issueId: selectedId as string }),
    enabled: selectedId !== null && snapshot?.state === "ready",
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  const totalCount = snapshot?.issues.length ?? 0;
  const title = workspaceTitle?.trim() || "Current workspace";
  const showListControls = snapshot?.state === "ready" && snapshot.issues.length > 0;

  useEffect(() => {
    if (!layout.compact || selectedId === null) return;
    if (focusAccessibilityTarget(detailFocusRef.current, BACK_BUTTON_NATIVE_ID)) return;

    const interaction = InteractionManager.runAfterInteractions(() => {
      focusAccessibilityTarget(detailFocusRef.current, BACK_BUTTON_NATIVE_ID);
    });
    return () => interaction.cancel();
  }, [layout.compact, selectedId]);

  function registerIssueRow(issueId: string, nativeId: string, row: View | null) {
    if (row) issueRowRefs.current.set(issueId, row);
    else issueRowRefs.current.delete(issueId);

    if (
      !row ||
      !layout.compact ||
      selectedId !== null ||
      pendingFocusIssueIdRef.current !== issueId
    ) {
      return;
    }

    if (focusAccessibilityTarget(row, nativeId)) {
      pendingFocusIssueIdRef.current = null;
      originatingIssueIdRef.current = null;
      return;
    }

    InteractionManager.runAfterInteractions(() => {
      if (
        pendingFocusIssueIdRef.current === issueId &&
        issueRowRefs.current.get(issueId) === row &&
        focusAccessibilityTarget(row, nativeId)
      ) {
        pendingFocusIssueIdRef.current = null;
        originatingIssueIdRef.current = null;
      }
    });
  }

  function openIssue(issueId: string) {
    originatingIssueIdRef.current = issueId;
    setSelectedId(issueId);
  }

  function returnToList() {
    pendingFocusIssueIdRef.current = originatingIssueIdRef.current ?? selectedId;
    setSelectedId(null);
  }

  function renderIssue(issue: BeadSummary, lane: BeadLane, index: number, itemCount: number) {
    const selected = selectedId === issue.id;
    const nativeId = issueRowNativeId(issue.id);
    const metadata = [issue.issueType, issue.assignee ? `@${issue.assignee}` : null].filter(
      (value): value is string => Boolean(value),
    );
    const activity = [
      issue.dependencyCount > 0 ? countText(issue.dependencyCount, "dependency") : null,
      issue.dependentCount > 0 ? countText(issue.dependentCount, "dependent") : null,
      issue.commentCount > 0 ? countText(issue.commentCount, "comment") : null,
    ].filter((value): value is string => Boolean(value));

    return (
      <Pressable
        ref={(row) => registerIssueRow(issue.id, nativeId, row)}
        accessibilityRole="button"
        accessibilityLabel={issueAccessibilityLabel(issue, lane)}
        accessibilityState={{ selected }}
        nativeID={nativeId}
        onPress={() => openIssue(issue.id)}
        style={({ pressed }) => [
          styles.issueRow,
          index === 0 && styles.issueRowFirst,
          index === itemCount - 1 && styles.issueRowLast,
          selected && styles.issueRowSelected,
          pressed && styles.pressed,
        ]}
      >
        <View style={[styles.issueRail, { backgroundColor: laneColor(lane, theme.colors) }]} />
        <View style={styles.issueBody}>
          <View style={styles.issueTopLine}>
            <Text style={[styles.priority, { color: priorityColor(issue.priority, theme.colors) }]}>
              P{issue.priority}
            </Text>
            <Text selectable style={styles.issueId} numberOfLines={1}>
              {issue.id}
            </Text>
          </View>
          <Text selectable style={styles.issueTitle} numberOfLines={2}>
            {issue.title}
          </Text>
          <Text style={styles.issueMeta} numberOfLines={1}>
            {metadata.join(" · ")}
          </Text>
          {issue.labels.length ? (
            <View style={styles.rowLabels}>
              {issue.labels.map((label) => (
                <View key={label} style={styles.rowLabelBadge}>
                  <Text style={styles.rowLabelText} numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {activity.length ? (
            <Text style={styles.issueActivity} numberOfLines={1}>
              {activity.join(" · ")}
            </Text>
          ) : null}
        </View>
        <Icon name="ChevronRight" size={15} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  }

  function renderList() {
    const listHeader =
      snapshot?.truncated || snapshotError ? (
        <View style={styles.listNotices}>
          {snapshot?.truncated ? (
            <View accessibilityRole="alert" style={styles.truncationNotice}>
              <Icon name="AlertTriangle" size={16} color={theme.colors.statusWarning} />
              <Text style={styles.truncationText}>
                Showing the first 500 issues. Counts and search results may be incomplete.
              </Text>
            </View>
          ) : null}
          {snapshotError ? (
            <View accessibilityRole="alert" style={styles.inlineError}>
              <Text style={styles.inlineErrorTitle}>Refresh failed</Text>
              <Text style={styles.inlineErrorBody}>{errorMessage(snapshotError)}</Text>
            </View>
          ) : null}
        </View>
      ) : null;

    return (
      <SectionList<BeadSummary, BeadSection>
        style={styles.listScroll}
        contentContainerStyle={styles.listContent}
        sections={sections}
        keyExtractor={(issue) => issue.id}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={5}
        contentOffset={layout.compact ? { x: 0, y: listScrollOffsetRef.current } : undefined}
        onScroll={(event) => {
          listScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          activeFiltering ? (
            <StateCard
              body="Change the search text or filter to see more issues."
              icon="Search"
              styles={styles}
              theme={theme}
              title="No matching beads"
            />
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.laneHeading}>
            <View
              style={[styles.laneDot, { backgroundColor: laneColor(section.lane, theme.colors) }]}
            />
            <Text accessibilityRole="header" style={styles.laneTitle}>
              {section.title}
            </Text>
            <Text style={styles.laneCount}>{section.data.length}</Text>
          </View>
        )}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 ? (
            <Text style={styles.emptyLane}>No issues in this lane.</Text>
          ) : null
        }
        renderItem={({ item, index, section }) =>
          renderIssue(item, section.lane, index, section.data.length)
        }
      />
    );
  }

  let body: ReactNode;
  if (isSnapshotPending && !snapshot) {
    body = (
      <StateCard
        body="Reading this workspace’s Beads issue graph."
        icon="CircleDot"
        loading
        styles={styles}
        theme={theme}
        title="Loading Beads"
      />
    );
  } else if (snapshotError && !snapshot) {
    body = (
      <StateCard
        body={errorMessage(snapshotError)}
        icon="AlertTriangle"
        onRetry={() => void refetchSnapshot()}
        styles={styles}
        theme={theme}
        title="Could not load Beads"
      />
    );
  } else if (snapshot?.state === "bd_unavailable") {
    body = (
      <StateCard
        body={snapshot.message || "The bd CLI is not available on this Paseo host."}
        icon="AlertTriangle"
        onRetry={() => void refetchSnapshot()}
        styles={styles}
        theme={theme}
        title="Beads is unavailable"
      />
    );
  } else if (snapshot?.state === "not_initialized") {
    body = (
      <StateCard
        body={snapshot.message || "Beads is not initialized for this workspace."}
        icon="CircleDot"
        onRetry={() => void refetchSnapshot()}
        styles={styles}
        theme={theme}
        title="No Beads project"
      />
    );
  } else if (snapshot?.state === "ready" && snapshot.issues.length === 0 && !selectedId) {
    body = (
      <StateCard
        body="This workspace has no Beads issues yet."
        icon="CircleDot"
        styles={styles}
        theme={theme}
        title="No beads"
      />
    );
  } else if (snapshot?.state === "ready") {
    const detailPane = (
      <DetailPane
        backButtonRef={detailFocusRef}
        detail={detailResult?.detail}
        detailError={detailError}
        isDetailFetching={isDetailFetching}
        isDetailPending={isDetailPending}
        missing={detailResult?.detail === null}
        onBack={returnToList}
        onRetry={() => void refetchDetail()}
        selectedId={selectedId}
        showBack={layout.compact}
        styles={styles}
        theme={theme}
      />
    );
    body = layout.compact ? (
      selectedId ? (
        detailPane
      ) : (
        renderList()
      )
    ) : (
      <View style={styles.split}>
        <View style={styles.listPane}>{renderList()}</View>
        <View style={styles.detailPane}>{detailPane}</View>
      </View>
    );
  } else {
    body = (
      <StateCard
        body="The workspace did not return a usable Beads snapshot."
        icon="AlertTriangle"
        onRetry={() => void refetchSnapshot()}
        styles={styles}
        theme={theme}
        title="Unexpected Beads state"
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Dependency focus</Text>
            <Text accessibilityRole="header" style={styles.workspaceTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.refreshState} numberOfLines={1}>
              {isSnapshotFetching
                ? "Refreshing…"
                : snapshot
                  ? `Updated ${formatUpdatedAt(snapshot.refreshedAt)}`
                  : "Waiting for first refresh"}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isSnapshotFetching ? "Refreshing Beads" : "Refresh Beads"}
            onPress={() => void refetchSnapshot()}
            style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
          >
            <Icon
              name="RefreshCw"
              size={15}
              color={isSnapshotFetching ? theme.colors.accent : theme.colors.foreground}
            />
            <Text style={styles.refreshButtonText}>
              {isSnapshotFetching ? "Refreshing" : "Refresh"}
            </Text>
          </Pressable>
        </View>

        {showListControls ? (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.countRail}
            >
              {BEAD_LANES.map((lane) => (
                <View key={lane} style={styles.countItem}>
                  <View
                    style={[styles.countDot, { backgroundColor: laneColor(lane, theme.colors) }]}
                  />
                  <Text style={styles.countLabel}>
                    {BEAD_LANE_TITLES[lane]} {view.counts[lane]}
                  </Text>
                </View>
              ))}
            </ScrollView>

            <View style={styles.searchRow}>
              <Icon name="Search" size={15} color={theme.colors.foregroundMuted} />
              <TextInput
                accessibilityLabel="Search Beads"
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setSearch}
                placeholder="Search id, title, assignee, or label"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={search}
                style={styles.searchInput}
              />
            </View>

            <View style={styles.filterRow}>
              {FILTERS.map(({ id, title: filterTitle }) => {
                const selected = filter === id;
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="button"
                    accessibilityLabel={`Filter Beads by ${filterTitle}`}
                    accessibilityState={{ selected }}
                    onPress={() => setFilter(id)}
                    style={({ pressed }) => [
                      styles.filterChip,
                      selected && styles.filterChipSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.filterText, selected && styles.filterTextSelected]}>
                      {filterTitle}
                      {id === "all" ? ` ${totalCount}` : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}
      </View>
      <View style={styles.body}>{body}</View>
    </View>
  );
}

function createStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    header: {
      paddingHorizontal: compact ? 14 : 20,
      paddingTop: compact ? 14 : 18,
      paddingBottom: 12,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    titleBlock: { flex: 1, minWidth: 0, gap: 2 },
    eyebrow: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    workspaceTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 19 : 22,
      fontWeight: "700",
    },
    refreshState: { color: theme.colors.foregroundMuted, fontSize: 11 },
    refreshButton: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 11,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    refreshButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    countRail: { gap: 6 },
    countItem: {
      minHeight: 27,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    countDot: { width: 7, height: 7, borderRadius: 4 },
    countLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    searchRow: {
      height: 36,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    searchInput: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 0,
      color: theme.colors.foreground,
      fontSize: 13,
    },
    filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    filterChip: {
      minHeight: 30,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 10,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    filterChipSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    filterText: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" },
    filterTextSelected: { color: theme.colors.accentForeground },
    body: { flex: 1, minHeight: 0 },
    split: { flex: 1, minHeight: 0, flexDirection: "row" },
    listPane: {
      width: "46%",
      minWidth: 320,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.colors.border,
    },
    detailPane: { flex: 1, minWidth: 0 },
    listScroll: { flex: 1 },
    listContent: { padding: compact ? 10 : 14, paddingBottom: 32 },
    listNotices: { gap: 10 },
    laneHeading: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      marginTop: 14,
      marginBottom: 7,
      paddingHorizontal: 3,
    },
    laneDot: { width: 8, height: 8, borderRadius: 4 },
    laneTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "700", flex: 1 },
    laneCount: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    emptyLane: {
      paddingVertical: 14,
      paddingHorizontal: 12,
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 9,
      backgroundColor: theme.colors.surface1,
    },
    issueRow: {
      minHeight: 86,
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      overflow: "hidden",
      paddingRight: 10,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    issueRowFirst: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopLeftRadius: 9,
      borderTopRightRadius: 9,
    },
    issueRowLast: { borderBottomLeftRadius: 9, borderBottomRightRadius: 9 },
    issueRowSelected: { backgroundColor: theme.colors.surface2 },
    issueRail: { alignSelf: "stretch", width: 3 },
    issueBody: { flex: 1, minWidth: 0, paddingVertical: 9, gap: 4 },
    issueTopLine: { flexDirection: "row", alignItems: "center", gap: 7 },
    priority: { fontSize: 11, fontWeight: "800" },
    issueId: {
      flex: 1,
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontFamily: ID_FONT_FAMILY,
    },
    issueTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600", lineHeight: 18 },
    issueMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    issueActivity: { color: theme.colors.foregroundMuted, fontSize: 10 },
    rowLabels: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
    rowLabelBadge: {
      maxWidth: 150,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: theme.colors.surface2,
    },
    rowLabelText: { color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "600" },
    truncationNotice: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      padding: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.statusWarning,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    truncationText: { flex: 1, color: theme.colors.foreground, fontSize: 12, lineHeight: 17 },
    inlineError: {
      gap: 3,
      padding: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.statusDanger,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    inlineErrorTitle: { color: theme.colors.statusDanger, fontSize: 12, fontWeight: "700" },
    inlineErrorBody: { color: theme.colors.foreground, fontSize: 12, lineHeight: 17 },
    stateCard: {
      alignSelf: "center",
      alignItems: "center",
      justifyContent: "center",
      maxWidth: 460,
      minHeight: 180,
      padding: 24,
      gap: 8,
    },
    stateTitle: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: "700",
      textAlign: "center",
    },
    stateBody: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 19,
      textAlign: "center",
    },
    secondaryButton: {
      minHeight: 34,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    detailRoot: { flex: 1 },
    detailEmpty: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 28,
      gap: 8,
    },
    detailScroll: { flex: 1 },
    detailContent: { padding: compact ? 14 : 20, paddingBottom: 40, gap: 18 },
    backButton: {
      alignSelf: "flex-start",
      minHeight: 34,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    backText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    detailHeading: { gap: 7 },
    detailIdRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    detailId: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontFamily: ID_FONT_FAMILY,
      fontWeight: "600",
    },
    detailTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 19 : 22,
      lineHeight: compact ? 25 : 29,
      fontWeight: "700",
    },
    detailRefreshState: { color: theme.colors.foregroundMuted, fontSize: 10 },
    readinessBadge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
    },
    readinessText: { fontSize: 10, fontWeight: "700" },
    factGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    fact: {
      width: compact ? "47%" : "31%",
      minWidth: 110,
      padding: 9,
      gap: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 7,
      backgroundColor: theme.colors.surface1,
    },
    factLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 9,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    factValue: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    detailSection: { gap: 7 },
    sectionHeadingRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    sectionTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "700" },
    sectionCount: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    sectionCopy: { color: theme.colors.foreground, fontSize: 13, lineHeight: 20 },
    sectionEmpty: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    labelRail: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
    labelBadge: {
      paddingHorizontal: 7,
      paddingVertical: 4,
      borderRadius: 5,
      backgroundColor: theme.colors.surface2,
    },
    labelText: { color: theme.colors.foreground, fontSize: 11, fontWeight: "600" },
    relationshipList: {
      overflow: "hidden",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    relationshipRow: {
      padding: 10,
      gap: 3,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    relationshipHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    relationshipId: {
      flex: 1,
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontFamily: ID_FONT_FAMILY,
      fontWeight: "600",
    },
    relationshipStatus: { color: theme.colors.foregroundMuted, fontSize: 10 },
    relationshipTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    relationshipMeta: { color: theme.colors.foregroundMuted, fontSize: 10 },
    pressed: { opacity: 0.72 },
  });
}
