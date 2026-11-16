/**
 * Host-wide encoded-video launch option. The capture extension loads only at Chromium
 * launch, so every runtime creation reads the current value instead of a value
 * captured at process start. The daemon environment can force video on; the
 * persisted choice only ever adds it. A missing or corrupt file means disabled.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserVideoSettings } from "../shared/browser";

export const VIDEO_PREFERENCE_FILE = "video-preference.json";
const VIDEO_ENV = "PASEO_SHARED_BROWSER_VIDEO";
const videoPreferenceSchema = z.object({ enabled: z.boolean() });

export function isVideoForcedByHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VIDEO_ENV] === "1";
}

async function readPersistedVideoEnabled(root: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, VIDEO_PREFERENCE_FILE), "utf8");
    const parsed = videoPreferenceSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.enabled;
  } catch {
    return false;
  }
}

export async function readVideoSettings(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserVideoSettings> {
  const forcedByHost = isVideoForcedByHost(env);
  return { enabled: forcedByHost || (await readPersistedVideoEnabled(root)), forcedByHost };
}

/** Atomic replace: a reader sees the previous or the next document, never a partial one. */
export async function writeVideoEnabled(root: string, enabled: boolean): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, VIDEO_PREFERENCE_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
