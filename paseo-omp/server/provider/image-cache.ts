import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { getOmpImage } from "../../shared/provider-image";
import type { OmpImageMimeType } from "./image";

/** Matches the projector's 8 MiB encoded image bound. */
const MAX_CACHED_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_FILES = 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OMP_IMAGE_REF = /^[0-9a-f]{64}$/u;
const CACHED_IMAGE_FILE = /^[0-9a-f]{64}\.(?:gif|jpg|png|webp)$/u;
/** Temp files a crash left between write and rename; never counted toward the cache limits. */
const PENDING_IMAGE_FILE = /^\.[0-9a-f]{64}\.[0-9a-f]{16}\.tmp$/u;
const STALE_PENDING_MS = 5 * 60 * 1000;
const MISSING_FILE_CODES: Readonly<Record<string, true>> = { ENOENT: true, ELOOP: true };

const IMAGE_EXTENSIONS: Readonly<Record<OmpImageMimeType, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface OmpImageCacheLimits {
  maxImageBytes: number;
  maxBytes: number;
  maxFiles: number;
}

const DEFAULT_LIMITS: OmpImageCacheLimits = {
  maxImageBytes: MAX_CACHED_IMAGE_BYTES,
  maxBytes: MAX_CACHE_BYTES,
  maxFiles: MAX_CACHE_FILES,
};

export class OmpImageCacheError extends Error {
  override readonly name = "OmpImageCacheError";
}

interface CachedImageEntry {
  name: string;
  bytes: number;
  modifiedMs: number;
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** Paseo resolves its home the same way, so an isolated daemon keeps images in its own home. */
export function ompImageCacheDir(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = environment.PASEO_HOME ?? "~/.paseo";
  const home = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return join(resolve(home), "plugin-data", "paseo-omp", "images");
}

export function ompImageRef(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Content-addressed image files that outlive the timeline item naming them. Each file is
 * `<sha256>.<ext>`; reads rebuild the path from a validated hash and verify the content, so a
 * caller can never reach another file. The oldest files are evicted past the size and count limits.
 */
export class OmpImageCache {
  constructor(
    readonly directory: string,
    private readonly limits: OmpImageCacheLimits = DEFAULT_LIMITS,
  ) {}

  /** Returns the reference even when the write fails; readers then report the image as missing. */
  store(bytes: Uint8Array, mimeType: OmpImageMimeType): string {
    const ref = ompImageRef(bytes);
    try {
      this.write(ref, bytes, mimeType);
    } catch (error) {
      if (!(error instanceof OmpImageCacheError) && !isFileSystemError(error)) throw error;
      console.error(`OMP image cache write failed { reason: ${error.message} }`);
    }
    return ref;
  }

  read(ref: string, mimeType: OmpImageMimeType): Buffer | undefined {
    if (!OMP_IMAGE_REF.test(ref)) return undefined;
    const path = this.path(ref, mimeType);
    // Windows has no O_NOFOLLOW; refuse a symlink there before opening it.
    if (
      constants.O_NOFOLLOW === undefined &&
      lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()
    ) {
      return undefined;
    }
    let descriptor: number;
    try {
      descriptor = openSync(
        path,
        // O_NONBLOCK keeps a FIFO planted under the image's name from hanging the worker.
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (isFileSystemError(error) && error.code && MISSING_FILE_CODES[error.code]) return;
      throw error;
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > this.limits.maxImageBytes) return;
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read === 0) return;
        offset += read;
      }
      if (ompImageRef(bytes) !== ref) return;
      this.touch(descriptor, path);
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  }

  /** Recency only orders eviction, so a failed touch never discards verified bytes. */
  private touch(descriptor: number, path: string): void {
    const now = new Date();
    try {
      futimesSync(descriptor, now, now);
    } catch (error) {
      if (!isFileSystemError(error)) throw error;
      // Windows rejects futimes on a read-only descriptor with EPERM.
      try {
        utimesSync(path, now, now);
      } catch (fallbackError) {
        if (!isFileSystemError(fallbackError)) throw fallbackError;
      }
    }
  }

  private path(ref: string, mimeType: OmpImageMimeType): string {
    return join(this.directory, `${ref}.${IMAGE_EXTENSIONS[mimeType]}`);
  }

  private write(ref: string, bytes: Uint8Array, mimeType: OmpImageMimeType): void {
    if (bytes.byteLength > this.limits.maxImageBytes) {
      throw new OmpImageCacheError("image exceeds the cache size limit");
    }
    this.ensureDirectory();
    const path = this.path(ref, mimeType);
    // A file of the wrong size (for example truncated by a crash) is rewritten, not trusted.
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing?.isFile() && existing.size === bytes.byteLength) {
      const now = new Date();
      utimesSync(path, now, now);
      return;
    }
    const pending = join(this.directory, `.${ref}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(pending, bytes, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      renameSync(pending, path);
    } finally {
      rmSync(pending, { force: true });
    }
    this.evict(path);
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stat = lstatSync(this.directory);
    const ownedByAnotherUser = process.getuid !== undefined && stat.uid !== process.getuid();
    if (!stat.isDirectory() || ownedByAnotherUser) {
      throw new OmpImageCacheError("image cache directory is not a private directory");
    }
    chmodSync(this.directory, PRIVATE_DIRECTORY_MODE);
  }

  private evict(keepPath: string): void {
    const entries: CachedImageEntry[] = [];
    let totalBytes = 0;
    const staleBefore = Date.now() - STALE_PENDING_MS;
    for (const name of readdirSync(this.directory)) {
      const path = join(this.directory, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      if (PENDING_IMAGE_FILE.test(name)) {
        if (stat.mtimeMs < staleBefore) rmSync(path, { force: true });
        continue;
      }
      if (!CACHED_IMAGE_FILE.test(name)) continue;
      entries.push({ name, bytes: stat.size, modifiedMs: stat.mtimeMs });
      totalBytes += stat.size;
    }
    entries.sort((left, right) => left.modifiedMs - right.modifiedMs);
    let count = entries.length;
    for (const entry of entries) {
      if (count <= this.limits.maxFiles && totalBytes <= this.limits.maxBytes) return;
      const path = join(this.directory, entry.name);
      if (path === keepPath) continue;
      rmSync(path, { force: true });
      count -= 1;
      totalBytes -= entry.bytes;
    }
  }
}

export function ompImageCache(): OmpImageCache {
  return new OmpImageCache(ompImageCacheDir());
}

export function resolveGetOmpImage(
  input: RpcInput<typeof getOmpImage>,
  cache: OmpImageCache,
): RpcOutput<typeof getOmpImage> {
  const bytes = cache.read(input.ref, input.mimeType);
  return bytes ? { status: "available", data: bytes.toString("base64") } : { status: "missing" };
}
