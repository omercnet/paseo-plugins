import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const MIN_VIEWPORT = { width: 320, height: 480 } as const;
export const MAX_VIEWPORT = { width: 1600, height: 1200 } as const;
export const FRAME_MAX_BYTES = 800_000;
export const FRAME_MAX_BASE64_CHARS = Math.ceil(FRAME_MAX_BYTES / 3) * 4;

export const DEVICE_PRESETS = [
  {
    id: "desktop-chrome",
    label: "Desktop Chrome",
    shortLabel: "Desktop",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    platform: "Win32",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36",
  },
  {
    id: "iphone-15-pro",
    label: "iPhone 15 Pro",
    shortLabel: "iPhone 15",
    viewport: { width: 393, height: 659 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    platform: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
  },
  {
    id: "pixel-7",
    label: "Pixel 7",
    shortLabel: "Pixel 7",
    viewport: { width: 412, height: 839 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    platform: "Linux armv81",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Mobile Safari/537.36",
  },
  {
    id: "ipad-pro-11",
    label: "iPad Pro 11",
    shortLabel: "iPad 11",
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    platform: "iPad",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
  },
] as const;

export const DEVICE_PRESET_IDS = [
  "desktop-chrome",
  "iphone-15-pro",
  "pixel-7",
  "ipad-pro-11",
] as const;

export type DevicePresetId = (typeof DEVICE_PRESET_IDS)[number];
const devicePresetIdSchema = z.enum(DEVICE_PRESET_IDS);

const workspaceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid workspace ID");
const opaqueTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid token");
const generationSchema = z.number().int().nonnegative();

export const viewportSchema = z.object({
  width: z.number().int().min(MIN_VIEWPORT.width).max(MAX_VIEWPORT.width),
  height: z.number().int().min(MIN_VIEWPORT.height).max(MAX_VIEWPORT.height),
});

export const browserStateSchema = z.object({
  sessionId: opaqueTokenSchema,
  workspaceId: workspaceIdSchema,
  status: z.enum(["starting", "ready", "error"]),
  url: z.string().max(8_192),
  title: z.string().max(1_024),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  viewport: viewportSchema,
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
  devicePresetId: devicePresetIdSchema.nullable(),
  userAgent: z.string().min(1).max(512),
  controller: z.enum(["none", "self", "other"]),
  controllerLabel: z.string().max(64).nullable(),
  controllerExpiresAt: z.string().datetime().nullable(),
  viewerCount: z.number().int().nonnegative(),
  error: z.string().max(2_048).nullable(),
});

export const browserFrameSchema = z.object({
  sessionId: opaqueTokenSchema,
  frameId: opaqueTokenSchema,
  mimeType: z.literal("image/jpeg"),
  transport: z.enum(["cdp-screencast", "screenshot"]),
  dataBase64: z.string().max(FRAME_MAX_BASE64_CHARS),
  byteLength: z.number().int().positive().max(FRAME_MAX_BYTES),
  width: z.number().int().positive().max(MAX_VIEWPORT.width),
  height: z.number().int().positive().max(MAX_VIEWPORT.height),
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
  capturedAt: z.string().datetime(),
});

export const attachBrowserRpc = defineRpc({
  name: "shared-browser.attach",
  input: z.object({
    workspaceId: workspaceIdSchema,
    viewerLabel: z.string().trim().min(1).max(64),
  }),
  output: z.object({
    viewerToken: opaqueTokenSchema,
    state: browserStateSchema,
  }),
});

export const detachBrowserRpc = defineRpc({
  name: "shared-browser.detach",
  input: z.object({ viewerToken: opaqueTokenSchema }),
  output: z.object({ detached: z.boolean() }),
});

export const listOpenBrowserWorkspacesRpc = defineRpc({
  name: "shared-browser.presence",
  input: z.object({}),
  output: z.object({ workspaceIds: z.array(workspaceIdSchema).max(32) }),
});

export const captureBrowserRpc = defineRpc({
  name: "shared-browser.capture",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    quality: z.enum(["low", "medium", "high"]).default("medium"),
    knownFrameId: opaqueTokenSchema.nullable().default(null),
  }),
  output: z.object({
    state: browserStateSchema,
    frame: browserFrameSchema.nullable(),
  }),
});

export const acquireControlRpc = defineRpc({
  name: "shared-browser.control.acquire",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    takeover: z.boolean().default(false),
  }),
  output: z.object({
    controlToken: opaqueTokenSchema,
    state: browserStateSchema,
  }),
});

export const releaseControlRpc = defineRpc({
  name: "shared-browser.control.release",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
  }),
  output: z.object({ state: browserStateSchema }),
});

const expectedStateSchema = z.object({
  sessionId: opaqueTokenSchema,
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
});

export const navigateBrowserRpc = defineRpc({
  name: "shared-browser.navigate",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("goto"), url: z.string().trim().min(1).max(8_192) }),
      z.object({ kind: z.literal("back") }),
      z.object({ kind: z.literal("forward") }),
      z.object({ kind: z.literal("reload") }),
    ]),
  }),
  output: z.object({ state: browserStateSchema }),
});

export const resizeBrowserRpc = defineRpc({
  name: "shared-browser.viewport.resize",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    viewport: viewportSchema,
  }),
  output: z.object({ state: browserStateSchema }),
});

export const applyDevicePresetRpc = defineRpc({
  name: "shared-browser.device.apply",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    presetId: devicePresetIdSchema,
  }),
  output: z.object({ state: browserStateSchema }),
});
const displayedPointSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive().max(16_384),
  height: z.number().finite().positive().max(16_384),
});

const targetFrameSchema = z.object({
  frameId: opaqueTokenSchema,
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
});

export const browserInputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    point: displayedPointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({
    kind: z.literal("move"),
    point: displayedPointSchema,
  }),
  z.object({
    kind: z.literal("drag"),
    start: displayedPointSchema,
    end: displayedPointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    kind: z.literal("scroll"),
    point: displayedPointSchema,
    deltaX: z.number().finite().min(-4_000).max(4_000),
    deltaY: z.number().finite().min(-4_000).max(4_000),
  }),
  z.object({
    kind: z.literal("type"),
    text: z.string().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
    ]),
  }),
]);

export const sendBrowserInputRpc = defineRpc({
  name: "shared-browser.input",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    target: targetFrameSchema,
    event: browserInputEventSchema,
  }),
  output: z.object({ state: browserStateSchema }),
});

export type BrowserState = z.output<typeof browserStateSchema>;
export type BrowserFrame = z.output<typeof browserFrameSchema>;
export type BrowserInputEvent = z.output<typeof browserInputEventSchema>;
export type Viewport = z.output<typeof viewportSchema>;

export interface MappedPoint {
  x: number;
  y: number;
}

export function mapDisplayedPoint(
  point: z.output<typeof displayedPointSchema>,
  viewport: Viewport,
): MappedPoint {
  if (point.x > point.width || point.y > point.height) {
    throw new Error("Pointer coordinates are outside the displayed frame");
  }
  return {
    x: Math.min(viewport.width - 1, Math.max(0, (point.x / point.width) * viewport.width)),
    y: Math.min(viewport.height - 1, Math.max(0, (point.y / point.height) * viewport.height)),
  };
}
