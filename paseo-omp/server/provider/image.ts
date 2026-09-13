import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OmpImageMimeType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

const IMAGE_MIME_TYPES: Readonly<Record<string, true>> = {
  "image/gif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
};

export function isOmpImageMimeType(value: string): value is OmpImageMimeType {
  return IMAGE_MIME_TYPES[value] === true;
}
const ATTACHMENT_DIRECTORY_PREFIX = "paseo-omp-attachments-";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MATERIALIZED_IMAGE_BYTES = 16 * 1024 * 1024;

function imageExtension(mimeType: OmpImageMimeType): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType.slice("image/".length);
}

export class OmpImageMaterializer {
  private directory: string | null = null;
  private readonly files = new Map<string, { path: string; bytes: number; references: number }>();
  private retainedBytes = 0;

  constructor(private readonly maxBytes = MAX_MATERIALIZED_IMAGE_BYTES) {}

  materialize(data: string, mimeType: OmpImageMimeType): string {
    const bytes = Buffer.from(data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.files.get(hash);
    if (existing) {
      existing.references += 1;
      return existing.path;
    }
    if (this.retainedBytes + bytes.byteLength > this.maxBytes) {
      throw new Error("OMP materialized image budget exceeded");
    }
    if (!this.directory || !this.directoryIsReusable()) {
      this.directory = mkdtempSync(join(tmpdir(), ATTACHMENT_DIRECTORY_PREFIX));
      chmodSync(this.directory, PRIVATE_DIRECTORY_MODE);
      this.files.clear();
      this.retainedBytes = 0;
    }
    const path = join(this.directory, `${hash}.${imageExtension(mimeType)}`);
    try {
      writeFileSync(path, bytes, { mode: PRIVATE_FILE_MODE });
      chmodSync(path, PRIVATE_FILE_MODE);
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    this.files.set(hash, { path, bytes: bytes.byteLength, references: 1 });
    this.retainedBytes += bytes.byteLength;
    return path;
  }

  release(paths: readonly string[]): void {
    for (const path of paths) {
      const entry = [...this.files.entries()].find(([, candidate]) => candidate.path === path);
      if (!entry) continue;
      const [hash, file] = entry;
      file.references -= 1;
      if (file.references > 0) continue;
      rmSync(file.path, { force: true });
      this.files.delete(hash);
      this.retainedBytes -= file.bytes;
    }
    if (this.files.size === 0 && this.directory) {
      rmSync(this.directory, { force: true, recursive: true });
      this.directory = null;
    }
  }

  clear(): void {
    if (this.directory) rmSync(this.directory, { force: true, recursive: true });
    this.files.clear();
    this.retainedBytes = 0;
  }

  private directoryIsReusable(): boolean {
    if (!this.directory) return false;
    try {
      if (!lstatSync(this.directory).isDirectory()) return false;
      chmodSync(this.directory, PRIVATE_DIRECTORY_MODE);
      return true;
    } catch {
      return false;
    }
  }
}

export function isValidImagePayload(
  data: string,
  mimeType: string,
  maxEncodedLength: number,
): boolean {
  if (
    data.length === 0 ||
    data.length > maxEncodedLength ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) ||
    !isOmpImageMimeType(mimeType)
  ) {
    return false;
  }
  const bytes = Buffer.from(data, "base64");
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    return (
      bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
        bytes.subarray(0, 6).toString("ascii") === "GIF89a")
    );
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}
