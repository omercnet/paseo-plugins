/** Per-tab state Paseo persists across tab restoration and app reloads. */
import { z } from "zod";
import { browserTabIdSchema } from "../shared/browser";

export const browserPanelStateSchema = z.object({
  scaleMode: z.enum(["fit", "actual"]),
  selectedTabId: browserTabIdSchema.nullable(),
});
export type BrowserPanelState = z.infer<typeof browserPanelStateSchema>;

export const DEFAULT_BROWSER_PANEL_STATE: BrowserPanelState = {
  scaleMode: "fit",
  selectedTabId: null,
};
