import type { PaseoApi } from "@getpaseo/client";
import type { GasCitySession } from "../shared";

export interface OpenSessionInPaseoInput {
  paseo: PaseoApi;
  session: Pick<GasCitySession, "cityName" | "sessionName" | "title">;
  endpointUrl: string;
  workspaceId?: string;
  cwd?: string;
  onOpenAgent?: (agentId: string) => void;
}

export function gasCityAgentConfig(input: {
  cityName: string;
  sessionName: string;
  endpointUrl: string;
}) {
  return {
    provider: "gas-city-session",
    options: {
      cityName: input.cityName,
      sessionName: input.sessionName,
      endpointUrl: input.endpointUrl,
    },
  } as const;
}

export async function openSessionInPaseo(input: OpenSessionInPaseoInput): Promise<string> {
  const options = {
    config: gasCityAgentConfig({
      cityName: input.session.cityName,
      sessionName: input.session.sessionName,
      endpointUrl: input.endpointUrl,
    }),
    title: `Gas City: ${input.session.title}`,
  };

  const created = input.workspaceId
    ? await input.paseo.workspaces.ref(input.workspaceId).agents.create(options)
    : await input.paseo.agents.create({
        ...options,
        cwd: input.cwd ?? ".",
      });
  input.onOpenAgent?.(created.id);
  return created.id;
}
