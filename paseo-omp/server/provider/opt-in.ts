import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const MARKER_FILE = "provider-opt-in.json";
const MAX_EVIDENCE_FILES = 10_000;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

const MarkerSchema = z.object({ version: z.literal(1), legacyUse: z.literal(true) });
const ProviderEntrySchema = z.object({ extends: z.string().optional() });
const ConfigSchema = z.object({
  agents: z
    .object({
      providers: z.record(z.string(), ProviderEntrySchema).optional(),
      metadataGeneration: z
        .object({ providers: z.array(z.object({ provider: z.string() })).optional() })
        .optional(),
    })
    .optional(),
  daemon: z
    .object({ agentProfiles: z.array(z.object({ provider: z.string() })).optional() })
    .optional(),
});
const AgentRecordSchema = z.object({ provider: z.string() });
const ScheduleSchema = z.object({
  target: z.object({ config: z.object({ provider: z.string() }).optional() }),
});

/** Paseo resolves its home the same way, so an isolated daemon keeps plugin data in its own home. */
export function paseoHomeDir(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = environment.PASEO_HOME ?? "~/.paseo";
  const home = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return resolve(home);
}

function isPluginProviderId(provider: string | undefined): boolean {
  return provider === "omp-plugin" || provider?.startsWith("omp-plugin-") === true;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Parsed JSON, or undefined when the file does not exist; throws on anything unreadable. */
function readJson(path: string): unknown {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (size > MAX_EVIDENCE_BYTES) throw new Error(`${path} is too large to inspect`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function agentRecordFiles(home: string): string[] {
  const root = join(home, "agents");
  let projects: string[];
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return [jsonFiles(root), ...projects.map(jsonFiles)].flat();
}

/** Read on every start: a config entry that extends an absent plugin provider breaks the registry. */
function configUsesPluginProvider(home: string): boolean {
  const raw = readJson(join(home, "config.json"));
  if (raw === undefined) return false;
  const config = ConfigSchema.parse(raw);
  const providers = Object.entries(config.agents?.providers ?? {});
  const referenced = [
    ...(config.agents?.metadataGeneration?.providers ?? []),
    ...(config.daemon?.agentProfiles ?? []),
  ];
  return (
    providers.some(([id, entry]) => isPluginProviderId(id) || isPluginProviderId(entry.extends)) ||
    referenced.some((entry) => isPluginProviderId(entry.provider))
  );
}

/** Schedules and agent records, including archived ones. Throws when evidence cannot be read. */
function recordsUsePluginProvider(home: string): boolean {
  const schedules = jsonFiles(join(home, "schedules"));
  const agents = agentRecordFiles(home);
  if (schedules.length + agents.length > MAX_EVIDENCE_FILES) return true;
  return (
    schedules.some((file) =>
      isPluginProviderId(ScheduleSchema.parse(readJson(file)).target.config?.provider),
    ) || agents.some((file) => isPluginProviderId(AgentRecordSchema.parse(readJson(file)).provider))
  );
}

/**
 * The plugin's own providers are opt-in for new installs. A host that already used them keeps
 * them registered without configuration. Config references are read on every start. Agent and
 * schedule use is latched in a marker, so deleting the last old agent never hides the providers.
 * There is no marker for "new install": absence means not latched yet. Anything unreadable
 * keeps the providers on.
 */
export function pluginProvidersRequireConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const home = paseoHomeDir(environment);
  const directory = join(home, "plugin-data", "paseo-omp");
  const marker = join(directory, MARKER_FILE);
  try {
    const latched = readJson(marker);
    if (latched !== undefined) {
      MarkerSchema.parse(latched);
      return false;
    }
    if (configUsesPluginProvider(home)) return false;
    if (!recordsUsePluginProvider(home)) return true;
  } catch {
    return false;
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${JSON.stringify({ version: 1, legacyUse: true })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Unlatched, the next start finds the same evidence.
  }
  return false;
}
