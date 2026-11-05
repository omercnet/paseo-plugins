import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  MAX_TOOL_CONFIG_BYTES,
  type OmpToolConfigKind,
  type readOmpToolConfig,
  validateOmpToolConfig,
  type writeOmpToolConfig,
} from "../shared/omp-tool-config";
import { SerialMutationQueue } from "./mutation-queue";
import { ompAgentDir } from "./paths";
import { OmpPublicError } from "./provider/security";

export class OmpToolConfigError extends OmpPublicError {}

type ReadInput = RpcInput<typeof readOmpToolConfig>;
type WriteInput = RpcInput<typeof writeOmpToolConfig>;

function variantsOf(kind: OmpToolConfigKind): string[] {
  return [`.${kind}.json`, `${kind}.yaml`, `.${kind}.yaml`, `${kind}.yml`, `.${kind}.yml`];
}

function locate({ cwd, kind }: Pick<ReadInput, "cwd" | "kind">) {
  if (cwd !== undefined && (!isAbsolute(cwd) || cwd.includes("\0"))) {
    throw new OmpToolConfigError("The workspace path is invalid.");
  }
  const directory = cwd === undefined ? ompAgentDir() : join(cwd, ".omp");
  return { directory, path: join(directory, `${kind}.json`) };
}

/** A cloned project could point .omp anywhere, so a project folder that is a symlink is refused. */
async function refuseLinkedProjectFolder(directory: string, cwd: string | undefined) {
  if (cwd === undefined) return;
  try {
    if ((await lstat(directory)).isSymbolicLink()) {
      throw new OmpToolConfigError("A symlinked .omp folder cannot be edited here.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function revisionOf(text: string | null): string {
  return text === null ? "" : createHash("sha256").update(text).digest("hex");
}

/** The file's text, or null when it does not exist. A symlink or an oversized file is refused. */
async function readExisting(path: string): Promise<string | null> {
  let size: number;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new OmpToolConfigError("A symlinked OMP configuration file cannot be edited here.");
    }
    if (!metadata.isFile()) throw new OmpToolConfigError("The OMP configuration is not a file.");
    size = metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (size > MAX_TOOL_CONFIG_BYTES) {
    throw new OmpToolConfigError("The OMP configuration file is too large to edit here.");
  }
  return readFile(path, "utf8");
}

async function existingVariants(directory: string, kind: OmpToolConfigKind): Promise<string[]> {
  const found: string[] = [];
  for (const name of variantsOf(kind)) {
    try {
      await lstat(join(directory, name));
      found.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

export async function resolveReadOmpToolConfig(
  input: ReadInput,
): Promise<RpcOutput<typeof readOmpToolConfig>> {
  const { directory, path } = locate(input);
  await refuseLinkedProjectFolder(directory, input.cwd);
  const text = await readExisting(path);
  return {
    path,
    exists: text !== null,
    text: text ?? "",
    revision: revisionOf(text),
    otherFiles: await existingVariants(directory, input.kind),
  };
}

async function writeToolConfig(input: WriteInput): Promise<RpcOutput<typeof writeOmpToolConfig>> {
  const errors = validateOmpToolConfig(input.kind, input.text);
  if (Buffer.byteLength(input.text) > MAX_TOOL_CONFIG_BYTES) {
    errors.push("The file is larger than 256 KiB, which this editor will not open again.");
  }
  if (errors.length > 0) return { outcome: "invalid", errors, revision: input.revision };

  const { directory, path } = locate(input);
  await refuseLinkedProjectFolder(directory, input.cwd);
  const snapshot = await readExisting(path);
  if (revisionOf(snapshot) !== input.revision) {
    return { outcome: "conflict", errors: [], revision: revisionOf(snapshot) };
  }

  const text = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
    if ((await readExisting(path)) !== snapshot) {
      return { outcome: "conflict", errors: [], revision: revisionOf(await readExisting(path)) };
    }
    await rename(temporaryPath, path);
    return { outcome: "saved", errors: [], revision: revisionOf(text) };
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

const writeQueue = new SerialMutationQueue();

export function resolveWriteOmpToolConfig(
  input: WriteInput,
): Promise<RpcOutput<typeof writeOmpToolConfig>> {
  return writeQueue.run(() => writeToolConfig(input));
}
