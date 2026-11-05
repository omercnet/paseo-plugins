import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { resolveOmpGeneratedImages } from "../shared/generated-image";
import { isValidImagePayload, type OmpImageMimeType } from "./provider/image";
import { MAX_CACHED_IMAGE_BYTES, type OmpImageCache } from "./provider/image-cache";
import { readRegularFile } from "./regular-file";

/** The name OMP's `generate_image` gives its output files, written to the OS temp directory. */
const GENERATED_FILE_NAME = /^omp-image-[A-Za-z0-9_-]+\.(?:gif|jpe?g|png|webp)$/u;
const MIME_BY_EXTENSION: Readonly<Record<string, OmpImageMimeType>> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Only `omp-image-*` files directly in the temp directory are read; any other path is refused. */
function readGeneratedImage(
  path: string,
): { bytes: Buffer; mimeType: OmpImageMimeType } | undefined {
  const name = basename(path);
  const mimeType = MIME_BY_EXTENSION[extname(name).toLowerCase()];
  if (!isAbsolute(path) || !GENERATED_FILE_NAME.test(name) || !mimeType) return undefined;
  let directory: string;
  try {
    directory = realpathSync(dirname(path));
    if (directory !== realpathSync(tmpdir())) return undefined;
  } catch {
    return undefined;
  }
  const bytes = readRegularFile(join(directory, name), MAX_CACHED_IMAGE_BYTES);
  // Only the magic bytes are checked, so encode only the header (12 bytes are 16 characters).
  if (!bytes || !isValidImagePayload(bytes.subarray(0, 12).toString("base64"), mimeType, 16)) {
    return undefined;
  }
  return { bytes, mimeType };
}

export function resolveGeneratedImages(
  input: RpcInput<typeof resolveOmpGeneratedImages>,
  cache: OmpImageCache,
): RpcOutput<typeof resolveOmpGeneratedImages> {
  return {
    images: input.paths.map((path) => {
      const image = readGeneratedImage(path);
      if (!image) return { status: "missing" as const };
      return {
        status: "available" as const,
        ref: cache.store(image.bytes, image.mimeType),
        mimeType: image.mimeType,
      };
    }),
  };
}
