import { constants } from "node:fs";
import { type FileHandle, lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { listOmpRules, OmpRule, OmpRulesList } from "../shared/omp-rules";
import { resolveOmpExecutable } from "./omp-settings";
import { currentOmpEnvironment, ompAgentDir } from "./paths";
import { OmpPublicError } from "./provider/security";
import {
  type BoundedRun,
  buildStatefulCommandEnv,
  defaultSpawn,
  runBounded,
} from "./provider-diagnostics";

const COMMAND_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RULES = 500;
const MAX_RULE_FILES = 200;
const MAX_RULE_FILE_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 2_000;
const MAX_LIST_ENTRIES = 50;

export class OmpRulesError extends OmpPublicError {}

export interface OmpRulesDependencies {
  resolveExecutable(): Promise<string | null>;
  run(executable: string, args: readonly string[], cwd: string): Promise<BoundedRun>;
  makeScratchDir(prefix: string): Promise<string>;
  removeDir(path: string): Promise<void>;
}

function clip(text: string): string {
  return text.slice(0, MAX_TEXT_CHARS);
}

function clipList(list: readonly string[]): string[] {
  return list.slice(0, MAX_LIST_ENTRIES).map(clip);
}

const TextList = z
  .array(z.string())
  .nullish()
  .transform((list) => clipList(list ?? []));
const OptionalText = z
  .string()
  .nullish()
  .transform((text) => (text ? clip(text) : null));

/** One entry of `omp ttsr list --json`. */
const WatchRuleSchema = z.object({
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(4_096),
  provider: z.string().min(1).max(64),
  condition: TextList,
  astCondition: TextList,
  question: OptionalText,
  scope: TextList,
  globs: TextList,
  agents: TextList,
  description: OptionalText,
});
type WatchRule = z.infer<typeof WatchRuleSchema>;

/** An entry that does not fit is left out, so one odd rule never hides the rest. */
export function parseWatchRules(raw: unknown): WatchRule[] {
  if (!Array.isArray(raw))
    throw new OmpRulesError("omp ttsr list gave output the plugin can't read");
  return raw.slice(0, MAX_RULES).flatMap((entry) => {
    const parsed = WatchRuleSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const DisabledRulesSchema = z.object({ value: z.array(z.string()) });
const BuiltinRulesSchema = z.object({ value: z.boolean() });

function isWithin(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function watchSource(rule: WatchRule, cwd: string | undefined): OmpRule["source"] {
  if (rule.provider === "builtin-defaults") return "builtin";
  if (rule.provider !== "native") return "imported";
  return cwd && isWithin(cwd, rule.path) ? "project" : "user";
}

function toWatchRule(rule: WatchRule, cwd: string | undefined): OmpRule {
  return {
    name: rule.name,
    kind: "watch",
    source: watchSource(rule, cwd),
    provider: rule.provider,
    description: rule.description,
    condition: rule.condition,
    astCondition: rule.astCondition,
    question: rule.question,
    scope: rule.scope,
    globs: rule.globs,
    agents: rule.agents,
    path: rule.path,
  };
}

async function runJson(
  dependencies: OmpRulesDependencies,
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<unknown> {
  const label = `omp ${args.join(" ")}`;
  const run = await dependencies.run(executable, args, cwd);
  if (run.outcome === "timeout") throw new OmpRulesError(`${label} timed out`);
  if (run.outcome !== "exited" || run.exitCode !== 0 || run.truncated) {
    throw new OmpRulesError(`${label} failed`);
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new OmpRulesError(`${label} gave output the plugin can't read`);
  }
}

async function readSetting<T>(
  dependencies: OmpRulesDependencies,
  executable: string,
  path: string,
  schema: z.ZodType<{ value: T }>,
  cwd: string,
): Promise<T> {
  const parsed = schema.safeParse(
    await runJson(dependencies, executable, ["config", "get", path, "--json"], cwd),
  );
  if (!parsed.success) throw new OmpRulesError(`OMP's ${path} setting could not be read`);
  return parsed.data.value;
}

/** Reads a regular file without following a symlink, or returns null. */
async function readRuleFile(path: string): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RULE_FILE_BYTES) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function isNonEmptyDirectory(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) return false;
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

async function ruleFilesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && [".md", ".mdc"].includes(extname(entry.name)))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_RULE_FILES)
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** OMP never treats home or a temporary root as a project. */
const DISCOVERY_CEILINGS = new Set([
  homedir(),
  tmpdir(),
  ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"]),
]);

function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  for (let current = resolve(cwd); ; current = dirname(current)) {
    dirs.push(current);
    if (dirname(current) === current) return dirs;
  }
}

/** The `.omp/` OMP takes the project `RULES.md` from: the nearest non-empty one up to the repo root. */
async function nearestProjectConfigDir(cwd: string): Promise<string | null> {
  const dirs = ancestors(cwd);
  let repoRoot: string | undefined;
  for (const dir of dirs) {
    const isRepoRoot = await lstat(join(dir, ".git")).then(
      () => true,
      () => false,
    );
    if (isRepoRoot) {
      repoRoot = dir;
      break;
    }
  }
  for (const dir of dirs) {
    if (DISCOVERY_CEILINGS.has(dir)) return null;
    if (await isNonEmptyDirectory(join(dir, ".omp"))) return join(dir, ".omp");
    if (dir === repoRoot) return null;
  }
  return null;
}

interface RuleFile {
  name: string;
  path: string;
  source: "project" | "user";
  /** `RULES.md` always applies, whatever its frontmatter says. */
  sticky: boolean;
}

/** OMP's own rule files, in its first-wins order. A global listing never reads project files. */
async function ruleFiles(cwd: string | undefined): Promise<RuleFile[]> {
  const agentDir = ompAgentDir(currentOmpEnvironment());
  const files: RuleFile[] = [];
  const add = (paths: string[], source: RuleFile["source"]) => {
    for (const path of paths) {
      const base = path.slice(path.lastIndexOf(sep) + 1);
      files.push({ name: base.replace(/\.(md|mdc)$/u, ""), path, source, sticky: false });
    }
  };
  if (cwd && resolve(cwd) !== homedir())
    add(await ruleFilesIn(join(cwd, ".omp", "rules")), "project");
  add(await ruleFilesIn(join(agentDir, "rules")), "user");
  files.push({ name: "RULES", path: join(agentDir, "RULES.md"), source: "user", sticky: true });
  const projectConfig = cwd ? await nearestProjectConfigDir(cwd) : null;
  if (projectConfig) {
    files.push({
      name: "RULES@project",
      path: join(projectConfig, "RULES.md"),
      source: "project",
      sticky: true,
    });
  }
  return files;
}

const FrontmatterSchema = z.record(z.string(), z.unknown());
type Frontmatter = z.infer<typeof FrontmatterSchema>;

function frontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---")) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return {};
  try {
    const parsed = FrontmatterSchema.safeParse(parseYaml(normalized.slice(3, end)));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function stringList(value: unknown, separator?: string): string[] {
  if (typeof value === "string") {
    const items = separator ? value.split(separator) : [value];
    return clipList(items.map((item) => item.trim()).filter(Boolean));
  }
  if (!Array.isArray(value)) return [];
  return clipList(value.filter((item): item is string => typeof item === "string"));
}

function classify(file: RuleFile, meta: Frontmatter): OmpRule | null {
  const description = typeof meta.description === "string" ? clip(meta.description) : null;
  let kind: OmpRule["kind"];
  if (file.sticky || meta.alwaysApply === true) kind = "always";
  else if (description) kind = "rulebook";
  else return null;
  return {
    name: file.name,
    kind,
    source: file.source,
    provider: "native",
    description,
    condition: [],
    astCondition: [],
    question: null,
    scope: [],
    globs: stringList(meta.globs),
    agents: stringList(meta.agents, ","),
    path: file.path,
  };
}

/** Always-apply and rulebook rules: OMP's `ttsr list` reports only watch rules. */
export async function readPromptRules(
  cwd: string | undefined,
  hidden: ReadonlySet<string>,
): Promise<OmpRule[]> {
  const seen = new Set<string>();
  const rules: OmpRule[] = [];
  for (const file of await ruleFiles(cwd)) {
    if (seen.has(file.name)) continue;
    const text = await readRuleFile(file.path);
    // OMP drops an empty RULES.md and an `enabled: false` file before the first-wins check.
    if (text === null || (file.sticky && text.trim() === "")) continue;
    const meta = frontmatter(text);
    if (meta.enabled === false) continue;
    seen.add(file.name);
    const rule = classify(file, meta);
    if (rule && !hidden.has(rule.name)) rules.push(rule);
  }
  return rules;
}

async function listRulesIn(
  runIn: string,
  cwd: string | undefined,
  dependencies: OmpRulesDependencies,
): Promise<OmpRulesList> {
  const executable = await dependencies.resolveExecutable();
  if (!executable) throw new OmpRulesError("The omp command was not found on this host");
  const [watch, disabled, builtinRules] = await Promise.all([
    runJson(dependencies, executable, ["ttsr", "list", "--json"], runIn).then(parseWatchRules),
    readSetting(dependencies, executable, "ttsr.disabledRules", DisabledRulesSchema, runIn),
    readSetting(dependencies, executable, "ttsr.builtinRules", BuiltinRulesSchema, runIn),
  ]);
  const disabledNames = clipList(disabled);
  const hidden = new Set([...watch.map((rule) => rule.name), ...disabledNames]);
  return {
    status: "ready",
    rules: [
      ...watch.map((rule) => toWatchRule(rule, cwd)),
      ...(await readPromptRules(cwd, hidden)),
    ],
    disabled: disabledNames,
    builtinRules,
  };
}

async function listRules(
  cwd: string | undefined,
  dependencies: OmpRulesDependencies,
): Promise<OmpRulesList> {
  if (cwd !== undefined) {
    const isDirectory =
      isAbsolute(cwd) &&
      !cwd.includes("\0") &&
      (await lstat(cwd).then(
        (stat) => stat.isDirectory(),
        () => false,
      ));
    if (!isDirectory) throw new OmpRulesError("The workspace path is invalid");
    return listRulesIn(cwd, cwd, dependencies);
  }
  // An empty directory keeps every project's rules out of the global listing.
  const prefix = join(tmpdir(), "paseo-omp-rules-");
  const scratch = await dependencies.makeScratchDir(prefix);
  try {
    return await listRulesIn(scratch, undefined, dependencies);
  } finally {
    // Only ever delete the directory this call created under the system temp directory.
    if (resolve(scratch).startsWith(prefix)) await dependencies.removeDir(scratch);
  }
}

export async function listOmpRulesWithDependencies(
  input: RpcInput<typeof listOmpRules>,
  dependencies: OmpRulesDependencies,
): Promise<OmpRulesList> {
  try {
    return await listRules(input.cwd, dependencies);
  } catch (error) {
    if (error instanceof OmpRulesError) return { status: "error", message: error.message };
    throw error;
  }
}

const DEFAULT_DEPENDENCIES: OmpRulesDependencies = {
  resolveExecutable: resolveOmpExecutable,
  run: (executable, args, cwd) =>
    runBounded(
      defaultSpawn,
      executable,
      args,
      buildStatefulCommandEnv(currentOmpEnvironment()),
      COMMAND_TIMEOUT_MS,
      KILL_GRACE_MS,
      MAX_OUTPUT_BYTES,
      cwd,
    ),
  makeScratchDir: (prefix) => mkdtemp(prefix),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
};

export function resolveListOmpRules(input: RpcInput<typeof listOmpRules>): Promise<OmpRulesList> {
  return listOmpRulesWithDependencies(input, DEFAULT_DEPENDENCIES);
}
