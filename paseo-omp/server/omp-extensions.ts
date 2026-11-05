import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type {
  listOmpExtensions,
  OmpExtensionItem,
  OmpExtensionsList,
  setOmpExtensionEnabled,
} from "../shared/omp-extensions";
import {
  type OmpListDependencies,
  ompListDependencies,
  readList,
  requireOmpExecutable,
  writeListEntry,
} from "./omp-list-setting";
import { inOmpScope } from "./omp-rules";
import { runSettingsMutation } from "./omp-settings";
import { ompAgentDir } from "./paths";
import { OmpPublicError } from "./provider/security";

const MAX_ENTRIES_PER_DIR = 200;
const MAX_ITEMS = 500;
const MAX_NAME_CHARS = 256;
const SCRIPT_SUFFIX = /\.(ts|js)$/u;
const TOOL_SUFFIX = /\.(ts|js|sh|bash|py)$/u;
const DECLARATION = /\.d\.(ts|js)$/u;

export class OmpExtensionsError extends OmpPublicError {}

type Found = Omit<OmpExtensionItem, "enabled">;
type Level = Found["level"];

interface Candidate {
  name: string;
  path: string;
}

async function isRealDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return info?.isDirectory() === true;
}

async function isRealFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return info?.isFile() === true;
}

/**
 * The visible entries of a real directory, bounded. A symlinked directory or entry is never
 * followed: a Dirent reports a link as a link, so it is neither a file nor a directory here.
 */
async function entriesOf(dir: string): Promise<Dirent[]> {
  if (!(await isRealDirectory(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .slice(0, MAX_ENTRIES_PER_DIR);
}

async function indexIn(dir: string): Promise<string | null> {
  for (const name of ["index.ts", "index.js"]) {
    if (await isRealFile(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** `extensions/<name>.ts|js` and `extensions/<name>/index.ts|js`, as OMP's native discovery. */
async function extensionCandidates(root: string): Promise<Candidate[]> {
  const dir = join(root, "extensions");
  const found: Candidate[] = [];
  for (const entry of await entriesOf(dir)) {
    if (entry.isFile() && SCRIPT_SUFFIX.test(entry.name) && !DECLARATION.test(entry.name)) {
      found.push({ name: entry.name.replace(SCRIPT_SUFFIX, ""), path: join(dir, entry.name) });
    } else if (entry.isDirectory()) {
      const index = await indexIn(join(dir, entry.name));
      if (index) found.push({ name: entry.name, path: index });
    }
  }
  return found;
}

/** `tools/<name>.<ts|js|sh|bash|py>` and `tools/<name>/index.ts`. */
async function toolCandidates(root: string): Promise<Candidate[]> {
  const dir = join(root, "tools");
  const found: Candidate[] = [];
  for (const entry of await entriesOf(dir)) {
    if (entry.isFile() && TOOL_SUFFIX.test(entry.name) && !DECLARATION.test(entry.name)) {
      found.push({ name: entry.name.replace(TOOL_SUFFIX, ""), path: join(dir, entry.name) });
    } else if (entry.isDirectory() && (await isRealFile(join(dir, entry.name, "index.ts")))) {
      found.push({ name: entry.name, path: join(dir, entry.name, "index.ts") });
    }
  }
  return found;
}

function entryFor(
  kind: Found["kind"],
  level: Level,
  name: string,
  path: string,
  id: string,
): Found {
  return { kind, name: name.slice(0, MAX_NAME_CHARS), level, path, id };
}

async function scanRoot(root: string, level: Level): Promise<Found[]> {
  const items: Found[] = [];
  for (const { name, path } of await extensionCandidates(root)) {
    items.push(entryFor("extension", level, name, path, `extension-module:${name}`));
  }
  const hooksReal = await isRealDirectory(join(root, "hooks"));
  for (const type of hooksReal ? ["pre", "post"] : []) {
    const dir = join(root, "hooks", type);
    for (const entry of await entriesOf(dir)) {
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      const tool = dot < 0 ? entry.name : entry.name.slice(0, dot);
      const id = `hook:${type}:${tool}:${entry.name}`;
      items.push(entryFor("hook", level, `${type}/${entry.name}`, join(dir, entry.name), id));
    }
  }
  for (const { name, path } of await toolCandidates(root)) {
    items.push(entryFor("tool", level, name, path, `tool:${name}`));
  }
  return items;
}

/**
 * What OMP would discover in the documented folders: the workspace's `.omp/` (project level) and
 * the agent directory (user level). It does not read `.gitignore`, `package.json` manifests or
 * the `extensions` setting, so it is a close inventory, not OMP's own list.
 */
export async function scanExtensions(cwd: string | undefined, agentDir: string): Promise<Found[]> {
  const projectRoot = cwd ? join(cwd, ".omp") : null;
  const project =
    projectRoot && (await isRealDirectory(projectRoot))
      ? await scanRoot(projectRoot, "project")
      : [];
  const user = await scanRoot(agentDir, "user");
  return [...project, ...user].slice(0, MAX_ITEMS);
}

export async function listOmpExtensionsWithDependencies(
  input: RpcInput<typeof listOmpExtensions>,
  dependencies: OmpListDependencies,
): Promise<OmpExtensionsList> {
  try {
    const executable = await requireOmpExecutable(dependencies);
    return await inOmpScope(input.cwd, dependencies, async (runIn) => {
      const list = await readList(dependencies, executable, "disabledExtensions", runIn);
      const disabled = new Set(list.map((entry) => entry.trim()));
      const items = (await scanExtensions(input.cwd, ompAgentDir())).map((item) => ({
        ...item,
        enabled: !disabled.has(item.id),
      }));
      return { status: "ready" as const, items };
    });
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

/** Only an id the scan finds right now can be written, so the list never collects stray entries. */
export async function setOmpExtensionEnabledWithDependencies(
  input: RpcInput<typeof setOmpExtensionEnabled>,
  dependencies: OmpListDependencies,
): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  try {
    const executable = await requireOmpExecutable(dependencies);
    await inOmpScope(input.cwd, dependencies, async (runIn) => {
      const items = await scanExtensions(input.cwd, ompAgentDir());
      if (!items.some((item) => item.id === input.id)) {
        throw new OmpExtensionsError("OMP does not discover that extension, hook or tool here");
      }
      const change = { cwd: input.cwd, list: "disabledExtensions" as const, entry: input.id };
      await runSettingsMutation(() =>
        writeListEntry({ ...change, enabled: input.enabled }, dependencies, executable, runIn),
      );
    });
    return { status: "ok" };
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

export function resolveListOmpExtensions(input: RpcInput<typeof listOmpExtensions>) {
  return listOmpExtensionsWithDependencies(input, ompListDependencies);
}

export function resolveSetOmpExtensionEnabled(input: RpcInput<typeof setOmpExtensionEnabled>) {
  return setOmpExtensionEnabledWithDependencies(input, ompListDependencies);
}
