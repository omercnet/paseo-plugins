import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CwdMode, PrRadarSettings } from "../shared/settings";
import { listLocalDirs, type RoutingScriptResult, runRoutingScript } from "../shared/viewer-scope";
import type { AgentLaunchOverrides, RadarRow } from "./radar";

export interface StartAgentLaunchRequest {
  row: RadarRow;
  targetDir: string | null;
  cwdMode: CwdMode;
  worktreeName: string | null;
  overrides: AgentLaunchOverrides;
  profileName: string;
}

function defaultHumanWorktreeName(row: RadarRow): string {
  const repoName = row.repository.split("/")[1] || "repo";
  const slug = row.headRefName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const num = row.number ?? "pr";
  return slug ? `${repoName}-pr-${num}-${slug}` : `${repoName}-pr-${num}`;
}

export function StartAgentModal({
  row,
  settings,
  theme,
  pending,
  error,
  onClose,
  onStart,
}: {
  row: RadarRow | null;
  settings: PrRadarSettings;
  theme: PluginSurfaceProps["theme"];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onStart: (request: StartAgentLaunchRequest) => void;
}) {
  const fetchDirs = useRpc(listLocalDirs);
  const invokeRouter = useRpc(runRoutingScript);

  const [dirInput, setDirInput] = useState("");
  const [cwdMode, setCwdMode] = useState<CwdMode>(settings.defaultCwdMode);
  const [worktreeName, setWorktreeName] = useState("");
  const [profileName, setProfileName] = useState(settings.defaultProfile);
  const [provider, setProvider] = useState(settings.defaultProvider);
  const [model, setModel] = useState(settings.defaultModel);
  const [effort, setEffort] = useState(settings.defaultEffort);
  const [modeId, setModeId] = useState(settings.defaultModeId);
  const [contextMode, setContextMode] = useState(settings.defaultContextMode);
  const [routeReason, setRouteReason] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);

  useEffect(() => {
    if (!row) return;
    setDirInput(row.localProjectRoot ?? "");
    setCwdMode(settings.defaultCwdMode);
    setWorktreeName(defaultHumanWorktreeName(row));
    setProfileName(settings.defaultProfile);
    setProvider(settings.defaultProvider);
    setModel(settings.defaultModel);
    setEffort(settings.defaultEffort);
    setModeId(settings.defaultModeId);
    setContextMode(settings.defaultContextMode);
    setRouteReason(null);
    setRouteError(null);
  }, [row, settings]);

  const dirQuery = useQuery({
    queryKey: ["pr-radar-dirs", settings.sourceCodeDir, dirInput, row?.repository ?? ""],
    queryFn: () =>
      fetchDirs({
        sourceCodeDir: settings.sourceCodeDir,
        query: dirInput,
        repository: row?.repository ?? "",
      }),
    enabled: Boolean(row),
    staleTime: 10_000,
  });

  async function handleRunRouter(targetRow: RadarRow) {
    if (!settings.routingScriptPath.trim()) return;
    setRoutingBusy(true);
    setRouteError(null);
    try {
      const result: RoutingScriptResult = await invokeRouter({
        scriptPath: settings.routingScriptPath,
        payload: {
          pr: {
            id: targetRow.id,
            number: targetRow.number,
            url: targetRow.url,
            title: targetRow.title,
            repository: targetRow.repository,
            baseRefName: targetRow.baseRefName,
            headRefName: targetRow.headRefName,
            isDraft: targetRow.isDraft,
            author: targetRow.author,
            authorKind: targetRow.authorKind,
            isSecurity: targetRow.isSecurity,
            comments: targetRow.comments,
            labels: targetRow.labels,
            bucket: targetRow.bucket,
            reason: targetRow.reason,
            reviewRequestedFromMe: targetRow.reviewRequestedFromMe,
            ownership: targetRow.ownership,
            checksStatus: targetRow.checksStatus,
            reviewDecision: targetRow.reviewDecision,
            mergeable: targetRow.mergeable,
            linkedIssues: targetRow.linkedIssues,
          },
          workspace: {
            targetDir: dirInput.trim() || null,
            cwdMode,
            localProjectRoot: targetRow.localProjectRoot,
            workspaceIds: targetRow.workspaceIds,
          },
          defaults: {
            profile: settings.defaultProfile,
            provider: settings.defaultProvider,
            model: settings.defaultModel,
            effort: settings.defaultEffort,
            modeId: settings.defaultModeId,
            contextMode: settings.defaultContextMode,
          },
        },
      });
      if (result.profile) setProfileName(result.profile);
      if (result.provider) setProvider(result.provider);
      if (result.model) setModel(result.model);
      if (result.thinkingOptionId) setEffort(result.thinkingOptionId);
      if (result.modeId) setModeId(result.modeId);
      if (result.contextMode) setContextMode(result.contextMode);
      setRouteReason(result.reason ?? "Routing script applied.");
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : "Routing script failed.");
    } finally {
      setRoutingBusy(false);
    }
  }

  useEffect(() => {
    if (!row || !settings.routingScriptPath.trim()) return;
    void handleRunRouter(row);
  }, [row?.id, settings.routingScriptPath]);

  const styles = useMemo(
    () => ({
      sectionLabel: {
        color: theme.colors.foreground,
        fontSize: 12,
        fontWeight: "600" as const,
      },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 16,
      },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 9,
        fontSize: 13,
      },
      listBox: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        maxHeight: 190,
        overflow: "hidden" as const,
      },
      listRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      listRowSelected: {
        backgroundColor: theme.colors.surface2,
      },
      listRowTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "500" as const,
      },
      listRowSub: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      pillRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      pill: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
      },
      pillActive: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      pillText: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600" as const,
      },
      pillTextActive: {
        color: theme.colors.accentForeground,
      },
      gridRow: {
        flexDirection: "row" as const,
        gap: 10,
      },
      gridCell: {
        flex: 1,
        gap: 4,
      },
      footer: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
        gap: 10,
        paddingTop: 6,
      },
      cancelButton: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
      },
      cancelText: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      primaryButton: {
        backgroundColor: theme.colors.accent,
        borderRadius: 999,
        paddingHorizontal: 16,
        paddingVertical: 8,
      },
      primaryText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
    }),
    [theme],
  );

  if (!row) return null;

  const entries = dirQuery.data?.entries ?? [];
  const suggestedClonePath =
    dirQuery.data?.suggestedClonePath ??
    `${settings.sourceCodeDir}/${row.repository.split("/")[1] || "repo"}`;

  return (
    <Modal
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Start New Agent · ${row.repository}${row.number ? ` #${row.number}` : ""}`}
      icon={<Icon name="Terminal" size={16} color={theme.colors.foreground} />}
    >
      <Modal.Content>
        <View style={{ gap: 14 }}>
          <View style={{ gap: 6 }}>
            <Text style={styles.sectionLabel}>
              Local directory or clone target (type to filter or pick below)
            </Text>
            <TextInput
              value={dirInput}
              onChangeText={setDirInput}
              placeholder={`Type path or filter ${settings.sourceCodeDir} (blank = clone)`}
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <View style={styles.listBox}>
              <Pressable
                onPress={() => setDirInput(suggestedClonePath)}
                style={[
                  styles.listRow,
                  dirInput.trim() === suggestedClonePath && styles.listRowSelected,
                ]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.listRowTitle} numberOfLines={1}>
                    Clone {row.repository} → {suggestedClonePath}
                  </Text>
                  <Text style={styles.listRowSub}>
                    Clones repo if missing and creates {cwdMode}
                  </Text>
                </View>
                <Icon name="Download" size={14} color={theme.colors.accent} />
              </Pressable>
              {entries.slice(0, 8).map((entry) => (
                <Pressable
                  key={entry.path}
                  onPress={() => setDirInput(entry.path)}
                  style={[styles.listRow, dirInput.trim() === entry.path && styles.listRowSelected]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.listRowTitle} numberOfLines={1}>
                      {entry.label}
                      {entry.isMatch ? " (match)" : ""}
                    </Text>
                    <Text style={styles.listRowSub} numberOfLines={1}>
                      {entry.path}
                      {entry.branch ? ` · ${entry.branch}` : ""}
                    </Text>
                  </View>
                  <Icon
                    name={
                      entry.kind === "worktree"
                        ? "GitBranch"
                        : entry.kind === "repo"
                          ? "FolderGit2"
                          : "Folder"
                    }
                    size={14}
                    color={theme.colors.foregroundMuted}
                  />
                </Pressable>
              ))}
            </View>
          </View>

          <View style={{ gap: 6 }}>
            <Text style={styles.sectionLabel}>Workspace mode</Text>
            <View style={styles.pillRow}>
              {(["CWD-WORKTREE", "CWD-BASE"] as const).map((mode) => (
                <Pressable
                  key={mode}
                  onPress={() => setCwdMode(mode)}
                  style={[styles.pill, cwdMode === mode && styles.pillActive]}
                >
                  <Text style={[styles.pillText, cwdMode === mode && styles.pillTextActive]}>
                    {mode === "CWD-WORKTREE"
                      ? "CWD-WORKTREE (PR worktree)"
                      : "CWD-BASE (base checkout)"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {cwdMode === "CWD-WORKTREE" ? (
            <View style={{ gap: 4 }}>
              <Text style={styles.sectionLabel}>Worktree name</Text>
              <TextInput
                value={worktreeName}
                onChangeText={setWorktreeName}
                placeholder={defaultHumanWorktreeName(row)}
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
            </View>
          ) : null}

          <View style={{ gap: 8 }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text style={styles.sectionLabel}>Agent launch options</Text>
              {settings.routingScriptPath.trim() ? (
                <Pressable
                  disabled={routingBusy}
                  onPress={() => void handleRunRouter(row)}
                  style={styles.pill}
                >
                  <Text style={styles.pillText}>
                    {routingBusy ? "Routing..." : "Re-run routing script"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {routeReason ? <Text style={styles.hint}>{routeReason}</Text> : null}
            {routeError ? (
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{routeError}</Text>
            ) : null}

            <View style={styles.gridRow}>
              <View style={styles.gridCell}>
                <Text style={styles.hint}>Profile</Text>
                <TextInput
                  value={profileName}
                  onChangeText={setProfileName}
                  placeholder="Model Router"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={styles.input}
                />
              </View>
              <View style={styles.gridCell}>
                <Text style={styles.hint}>Vendor / provider</Text>
                <TextInput
                  value={provider}
                  onChangeText={setProvider}
                  placeholder="Profile default"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  style={styles.input}
                />
              </View>
            </View>

            <View style={styles.gridRow}>
              <View style={styles.gridCell}>
                <Text style={styles.hint}>Model</Text>
                <TextInput
                  value={model}
                  onChangeText={setModel}
                  placeholder="Provider default"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  style={styles.input}
                />
              </View>
              <View style={styles.gridCell}>
                <Text style={styles.hint}>Effort (thinking)</Text>
                <TextInput
                  value={effort}
                  onChangeText={setEffort}
                  placeholder="low / medium / high"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  style={styles.input}
                />
              </View>
            </View>

            <View style={styles.gridRow}>
              <View style={styles.gridCell}>
                <Text style={styles.hint}>Mode</Text>
                <TextInput
                  value={modeId}
                  onChangeText={setModeId}
                  placeholder="default / bypassPermissions"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  style={styles.input}
                />
              </View>
              <View style={styles.gridCell}>
                <Text style={styles.hint}>Context mode</Text>
                <TextInput
                  value={contextMode}
                  onChangeText={setContextMode}
                  placeholder="Optional"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  style={styles.input}
                />
              </View>
            </View>
          </View>

          {error ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
          ) : null}

          <View style={styles.footer}>
            <Pressable disabled={pending} onPress={onClose} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={pending}
              onPress={() =>
                onStart({
                  row,
                  targetDir: dirInput.trim() || null,
                  cwdMode,
                  worktreeName: worktreeName.trim() || null,
                  profileName: profileName.trim(),
                  overrides: {
                    provider,
                    model,
                    thinkingOptionId: effort,
                    modeId,
                    contextMode,
                  },
                })
              }
              style={styles.primaryButton}
            >
              <Text style={styles.primaryText}>{pending ? "Starting..." : "Start New Agent"}</Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
