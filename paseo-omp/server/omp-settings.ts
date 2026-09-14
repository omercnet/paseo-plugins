import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import {
  type listOmpSettings,
  OMP_SETTINGS_CATALOG_VERSION,
  type OmpSetting,
  OmpSettingTypeSchema,
} from "../shared/omp-settings";

const execFileAsync = promisify(execFile);
const MAX_CONFIG_OUTPUT_BYTES = 2 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 15_000;

type OmpSettingRecord = {
  value?: unknown;
  redacted?: unknown;
  type?: unknown;
  description?: unknown;
};

export function parseOmpSettingsList(raw: unknown): OmpSetting[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("OMP returned an invalid settings document");
  }

  const settings: OmpSetting[] = [];
  for (const [path, candidate] of Object.entries(raw)) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as OmpSettingRecord;
    const type = OmpSettingTypeSchema.safeParse(entry.type);
    if (!type.success) continue;

    const redacted = entry.redacted === true;
    settings.push({
      path,
      type: type.data,
      description: typeof entry.description === "string" ? entry.description : "",
      ...(redacted ? { redacted: true } : { value: entry.value }),
    });
  }
  return settings;
}

export async function resolveListOmpSettings(_input: RpcInput<typeof listOmpSettings>): Promise<{
  catalogVersion: typeof OMP_SETTINGS_CATALOG_VERSION;
  available: boolean;
  settings: OmpSetting[];
  error?: string;
}> {
  const command = process.env.OMP_COMMAND ?? "omp";
  try {
    const { stdout } = await execFileAsync(command, ["config", "list", "--json"], {
      encoding: "utf8",
      env: process.env,
      maxBuffer: MAX_CONFIG_OUTPUT_BYTES,
      timeout: CONFIG_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(stdout);
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: true,
      settings: parseOmpSettingsList(parsed),
    };
  } catch {
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: false,
      settings: [],
      error: "OMP settings metadata is unavailable.",
    };
  }
}
