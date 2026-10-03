import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { KnowledgeSection } from "./knowledge-section";
import { resolveKnowledgeScope, type ScreenParams } from "./screen-scope";

export function ScopedKnowledgeSection({
  params,
  ...props
}: PluginSurfaceProps & { params: ScreenParams }) {
  const paseo = usePaseo();
  const scope = useQuery({
    queryKey: [
      "context-mode",
      props.host.id,
      "knowledge-scope",
      params.agentId,
      params.workspaceId,
    ],
    queryFn: () => resolveKnowledgeScope(paseo, params),
    retry: false,
  });
  if (scope.isPending)
    return (
      <Text style={{ color: props.theme.colors.foregroundMuted }}>Resolving Knowledge scope…</Text>
    );
  return (
    <View>
      {scope.error ? (
        <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>
          {scope.error.message}
        </Text>
      ) : null}
      <KnowledgeSection
        {...props}
        initialScope={scope.data ?? { provider: null, projectPath: "" }}
      />
    </View>
  );
}
