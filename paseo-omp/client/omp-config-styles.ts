import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import type { TextStyle, ViewStyle } from "react-native";

export interface OmpConfigStyles {
  root: ViewStyle;
  pageTitle: TextStyle;
  topTabs: ViewStyle;
  topTab: ViewStyle;
  topTabActive: ViewStyle;
  topTabLabel: TextStyle;
  topTabLabelActive: TextStyle;
  workspace: ViewStyle;
  categoryRail: ViewStyle;
  categoryList: ViewStyle;
  categoryButton: ViewStyle;
  categoryButtonActive: ViewStyle;
  categoryLabel: TextStyle;
  categoryLabelActive: TextStyle;
  categoryContent: ViewStyle;
  search: TextStyle;
  sectionHeader: ViewStyle;
  sectionHeaderRow: ViewStyle;
  sectionTitle: TextStyle;
  source: TextStyle;
  muted: TextStyle;
  error: TextStyle;
  refresh: ViewStyle;
  docsActions: ViewStyle;
  docLink: ViewStyle;
  docLinkPressed: ViewStyle;
  docLinkText: TextStyle;
  refreshLabel: TextStyle;
  helpActions: ViewStyle;
  helpReport: ViewStyle;
  helpReportText: TextStyle;
  helpLinkText: TextStyle;
  card: ViewStyle;
  cardHeader: ViewStyle;
  cardTitle: TextStyle;
  row: ViewStyle;
  rowLabel: TextStyle;
  rowValue: TextStyle;
  setting: ViewStyle;
  settingHeader: ViewStyle;
  settingPath: TextStyle;
  settingDescription: TextStyle;
  settingValue: TextStyle;
  collectionSummary: TextStyle;
  chipList: ViewStyle;
  chip: ViewStyle;
  chipText: TextStyle;
  recordList: ViewStyle;
  recordRow: ViewStyle;
  recordKey: TextStyle;
  recordValue: TextStyle;
  editorActions: ViewStyle;
  editorAction: ViewStyle;
  editorActionPrimary: ViewStyle;
  editorActionText: TextStyle;
  editorActionTextPrimary: TextStyle;
  scalarInput: TextStyle;
  resetAction: TextStyle;
}

export function useConfigStyles(
  theme: PluginSurfaceProps["theme"],
  compact: boolean,
): OmpConfigStyles {
  return useMemo(
    () => ({
      root: {
        flex: 1,
        gap: compact ? 10 : 14,
        padding: compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      pageTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 22 : 26,
        fontWeight: "700",
      },
      topTabs: {
        flexWrap: "wrap",
        flexDirection: "row",
        alignSelf: "flex-start",
        gap: 4,
        padding: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      topTab: {
        paddingHorizontal: compact ? 10 : 14,
        paddingVertical: 8,
        borderRadius: 7,
      },
      topTabActive: { backgroundColor: theme.colors.accent },
      topTabLabel: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" },
      topTabLabelActive: { color: theme.colors.accentForeground },
      workspace: {
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "flex-start",
        gap: compact ? 10 : 18,
      },
      categoryRail: {
        width: compact ? "100%" : 220,
        gap: 10,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      categoryList: { gap: 4 },
      categoryButton: { paddingHorizontal: 10, paddingVertical: 9, borderRadius: 7 },
      categoryButtonActive: { backgroundColor: theme.colors.surface2 },
      categoryLabel: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "500" },
      categoryLabelActive: { color: theme.colors.foreground, fontWeight: "700" },
      categoryContent: { flex: compact ? undefined : 1, minWidth: 0, gap: 10 },
      search: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
      },
      sectionHeader: { gap: 4, marginTop: compact ? 2 : 4 },
      sectionHeaderRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 16 : 18,
        fontWeight: "600",
      },
      source: { color: theme.colors.foregroundMuted, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      docsActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
      docLink: {
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
      },
      docLinkPressed: { opacity: 0.72 },
      docLinkText: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" },
      refresh: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      refreshLabel: { color: theme.colors.foreground, fontSize: 13 },
      helpActions: {
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
      },
      helpReport: {
        maxWidth: "100%",
        padding: compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      helpReportText: {
        color: theme.colors.foreground,
        fontSize: compact ? 11 : 12,
        lineHeight: compact ? 16 : 18,
      },
      helpLinkText: { color: theme.colors.accent, fontSize: 13, fontWeight: "600" },
      cardHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 8,
      },
      card: {
        gap: 8,
        padding: compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      cardTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
      row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
      rowLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
      rowValue: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
      setting: {
        gap: 5,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      settingHeader: {
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
      },
      settingPath: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
      settingDescription: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      settingValue: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
      collectionSummary: { color: theme.colors.foregroundMuted, fontSize: 12 },
      chipList: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
      chip: {
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      recordList: { gap: 6 },
      recordRow: {
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "flex-start" : "baseline",
        gap: compact ? 2 : 12,
        paddingVertical: 5,
      },
      recordKey: {
        width: compact ? undefined : 150,
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600",
      },
      recordValue: { flex: 1, color: theme.colors.foreground, fontSize: 12 },
      editorActions: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      editorAction: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      },
      editorActionPrimary: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
      editorActionText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
      editorActionTextPrimary: { color: theme.colors.accentForeground },
      scalarInput: {
        minWidth: 180,
        maxWidth: 420,
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface0,
        paddingHorizontal: 9,
        paddingVertical: 6,
        fontSize: 13,
      },
      resetAction: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" },
    }),
    [compact, theme],
  );
}
