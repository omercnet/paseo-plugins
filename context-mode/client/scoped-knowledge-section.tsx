import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { ErrorText, Pending } from "./controls";
import { KnowledgeSection, type KnowledgeSectionProps } from "./knowledge-section";
import { resolveKnowledgeScope, type ScreenParams } from "./screen-scope";

interface ScopedKnowledgeSectionProps extends Omit<KnowledgeSectionProps, "initialScope"> {
  params: ScreenParams;
}

export function ScopedKnowledgeSection({ params, ...props }: ScopedKnowledgeSectionProps) {
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
  if (scope.isPending) return <Pending theme={props.theme} label="Resolving knowledge scope..." />;
  if (scope.error)
    return (
      <View style={{ gap: 12 }}>
        <ErrorText theme={props.theme} error={scope.error} />
        <KnowledgeSection
          key="scope-error"
          {...props}
          initialScope={{ provider: null, projectPath: "" }}
        />
      </View>
    );
  const scopedProviderKnown = props.providers.includes(scope.data.provider ?? "");
  // Remount only when the resolved destination changes so stale form state never survives it.
  return (
    <KnowledgeSection
      key={JSON.stringify([scope.data.provider, scope.data.projectPath, scopedProviderKnown])}
      {...props}
      initialScope={scope.data}
    />
  );
}
