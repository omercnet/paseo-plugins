import { type PluginButtonContentProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type HubProcess, listHubProcesses, tailHubLog } from "../shared/hub";
import { type HubProcessTone, hubProcessTone } from "./hub-status";

const PROCESS_POLL_MS = 3_000;
const LOG_POLL_MS = 2_000;

function age(timestamp: number | null): string {
  if (timestamp === null) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function command(process: HubProcess): string {
  return [process.application, ...process.args].join(" ");
}

function toneColor(
  tone: HubProcessTone,
  colors: PluginButtonContentProps["theme"]["colors"],
): string {
  if (tone === "danger") return colors.statusDanger;
  if (tone === "warning") return colors.statusWarning;
  if (tone === "success") return colors.statusSuccess;
  return colors.foregroundMuted;
}

export function HubPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const cwd = useAgent(agentId, (agent) => agent.cwd) ?? "";
  const loadProcesses = useRpc(listHubProcesses);
  const loadLog = useRpc(tailHubLog);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const processes = useQuery({
    queryKey: ["paseo-omp", "processes", cwd],
    queryFn: () => loadProcesses({ cwd }),
    enabled: cwd.length > 0,
    refetchInterval: PROCESS_POLL_MS,
  });
  const log = useQuery({
    queryKey: ["paseo-omp", "log", cwd, selectedName],
    queryFn: () => loadLog({ cwd, name: selectedName ?? "" }),
    enabled: cwd.length > 0 && selectedName !== null,
    refetchInterval: LOG_POLL_MS,
  });
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 8 : 10 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      card: {
        gap: 4,
        padding: layout.compact ? 10 : 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      name: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flex: 1 },
      command: { color: theme.colors.foregroundMuted, fontSize: 12 },
      log: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
    }),
    [layout.compact, theme],
  );

  if (processes.isLoading) return <Text style={styles.muted}>Loading hub processes…</Text>;
  if (processes.error) return <Text style={styles.error}>Could not read omp hub state.</Text>;
  const items = processes.data?.processes ?? [];
  if (items.length === 0) return <Text style={styles.muted}>No hub-supervised processes.</Text>;

  return (
    <View style={styles.root}>
      {items.map((process) => {
        const tone = hubProcessTone(process);
        const selected = selectedName === process.name;
        const timestamp = process.exitedAt ?? process.startedAt ?? process.createdAt;
        return (
          <Pressable
            key={process.name}
            accessibilityRole="button"
            accessibilityLabel={`${selected ? "Hide" : "Show"} logs for ${process.name}`}
            onPress={() => setSelectedName(selected ? null : process.name)}
            style={styles.card}
          >
            <View style={styles.row}>
              <Text numberOfLines={1} style={styles.name}>
                {process.name}
              </Text>
              <Text style={{ color: toneColor(tone, theme.colors), fontSize: 12 }}>
                {process.state}
                {process.exitCode !== null ? ` · ${process.exitCode}` : ""}
                {timestamp !== null ? ` · ${age(timestamp)}` : ""}
              </Text>
            </View>
            <Text numberOfLines={2} style={styles.command}>
              {command(process)}
            </Text>
            {selected ? (
              log.isLoading ? (
                <Text style={styles.muted}>Loading logs…</Text>
              ) : log.error ? (
                <Text style={styles.error}>Could not read this process log.</Text>
              ) : (
                <Text selectable style={styles.log}>
                  {log.data?.truncated ? "… showing the latest 64 KiB\n" : ""}
                  {log.data?.content || "No output."}
                </Text>
              )
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
