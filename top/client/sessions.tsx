import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { Session } from "../shared/usage";
import { formatBytes, formatCores } from "./format";

export function sessionLabel(session: Session): string {
  return session.title || `Agent ${session.agentId.slice(0, 8)}`;
}

interface SessionsProps {
  theme: PluginTheme;
  /** `null` where the host cannot attribute processes to agents. */
  sessions: Session[] | null;
  other: { cores: number; rss: number };
  onOpenAgent?: (agentId: string) => void;
}

/** Load by agent session, busiest first, with what is actually burning it. */
export function Sessions({ theme, sessions, other, onOpenAgent }: SessionsProps) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const rows = [
    <Text key="heading" style={{ ...muted, letterSpacing: 0.6 }}>
      LOAD BY SESSION
    </Text>,
  ];

  if (sessions === null) {
    rows.push(
      <Text key="unsupported" style={muted}>
        Per-session load needs a Linux host.
      </Text>,
    );
  } else if (sessions.length === 0) {
    rows.push(
      <Text key="empty" style={muted}>
        No agent is running anything right now.
      </Text>,
    );
  }
  for (const session of sessions ?? []) {
    const detail = [session.workspace, session.command].filter(Boolean).join(" · ");
    rows.push(
      <Pressable
        key={session.agentId}
        accessibilityRole={onOpenAgent ? "button" : undefined}
        disabled={!onOpenAgent}
        onPress={() => onOpenAgent?.(session.agentId)}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}
      >
        <View style={{ width: 14 }}>
          {session.heavy && <Icon name="Flame" size={14} color={theme.colors.statusDanger} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14 }}>
            {sessionLabel(session)}
          </Text>
          <Text numberOfLines={1} style={muted}>
            {detail}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text
            style={{
              color: session.heavy ? theme.colors.statusDanger : theme.colors.foreground,
              fontSize: 14,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatCores(session.cores)}
          </Text>
          <Text style={{ ...muted, fontVariant: ["tabular-nums"] }}>
            {formatBytes(session.rss)}
          </Text>
        </View>
      </Pressable>,
    );
  }
  if (sessions !== null && (other.cores > 0 || other.rss > 0)) {
    rows.push(
      <View key="other" style={{ flexDirection: "row", gap: 10, paddingTop: 6 }}>
        <View style={{ width: 14 }} />
        <Text style={{ ...muted, flex: 1 }}>Everything else</Text>
        <Text style={{ ...muted, fontVariant: ["tabular-nums"] }}>
          {`${formatCores(other.cores)} · ${formatBytes(other.rss)}`}
        </Text>
      </View>,
    );
  }
  return <View style={{ gap: 2 }}>{rows}</View>;
}
