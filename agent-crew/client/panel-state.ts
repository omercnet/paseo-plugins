import { z } from "zod";
import { CREW_STATES, type CrewState } from "./crew";

/** Panel view state persisted with the tab so it survives tab restore and app reloads. */
export type PanelState = {
  state: CrewState | null;
  query: string;
  collapsedAgentIds: string[];
};

export const DEFAULT_PANEL_STATE: PanelState = { state: null, query: "", collapsedAgentIds: [] };

// Each field falls back on its own, so one bad value does not discard the rest.
export const panelStateSchema: z.ZodType<PanelState> = z.object({
  state: z
    .enum(CREW_STATES as [CrewState, ...CrewState[]])
    .nullable()
    .catch(null),
  query: z.string().catch(""),
  collapsedAgentIds: z.array(z.string()).catch([]),
});
