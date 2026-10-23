/** Per-tab state Paseo persists across tab restoration and app reloads. */
import { z } from "zod";

export const browserPanelStateSchema = z.object({
  scaleMode: z.enum(["fit", "actual"]),
  selectedTabId: z.string().nullable(),
});
export type BrowserPanelState = z.infer<typeof browserPanelStateSchema>;

export const DEFAULT_BROWSER_PANEL_STATE: BrowserPanelState = {
  scaleMode: "fit",
  selectedTabId: null,
};
