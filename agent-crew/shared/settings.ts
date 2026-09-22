import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_AUTO_OPEN_EXPLORER = false;

export const agentCrewSettingsSchema = z.object({
  autoOpenExplorer: z.boolean().default(DEFAULT_AUTO_OPEN_EXPLORER),
});

export const agentCrewSettings = defineSettings({
  id: "agent-crew-preferences",
  scope: "host",
  version: 1,
  schema: agentCrewSettingsSchema,
});

export const agentCrewSettingsRpc = settingsRpc(agentCrewSettings.id);
