/** JPEG quality and byte bounds shared by the human viewer, agent adapter and browser runtime. */
export const DEFAULT_CAPTURE_QUALITY = "high" as const;
export const JPEG_QUALITY = { low: 70, medium: 90, high: 95, maximum: 100 } as const;
export type CaptureQuality = keyof typeof JPEG_QUALITY;
export const DEFAULT_JPEG_QUALITY = JPEG_QUALITY[DEFAULT_CAPTURE_QUALITY];

// Detailed large views need enough room to retain text without exceeding bounded RPC payloads.
export const FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const FRAME_MAX_BASE64_CHARS = Math.ceil(FRAME_MAX_BYTES / 3) * 4;

/** Actual image pixels are independent of CSS layout and input coordinates for sharper phone capture. */
export function captureDimensions(viewport: { width: number; height: number }, captureScale = 1) {
  return {
    width: Math.round(viewport.width * captureScale),
    height: Math.round(viewport.height * captureScale),
  };
}
