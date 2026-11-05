import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { OMP_IMAGE_TIMELINE_KIND, ompImageTimelineSchema } from "../shared/provider-image";
import { isOmpImageMimeType, isValidImagePayload, type OmpImageMimeType } from "./provider/image";
import { MAX_CACHED_IMAGE_BYTES, type OmpImageCache, ompImageCache } from "./provider/image-cache";
import { readRegularFile } from "./regular-file";
import { readTail } from "./rule-notices";
import type { OmpTurnRow } from "./turn-rows";

const BLOB_REFERENCE = /^blob:sha256:([0-9a-f]{64})$/u;
const MAX_SCREENSHOTS = 16;
const LABEL = "Screenshots";

interface ScreenshotBlob {
  hash: string;
  mimeType: OmpImageMimeType;
}

/** `<agent dir>/sessions/<project>/<session>.jsonl` keeps its image blobs in `<agent dir>/blobs`. */
function blobDirectory(sessionFile: string): string | undefined {
  const sessions = dirname(dirname(sessionFile));
  return basename(sessions) === "sessions" ? join(dirname(sessions), "blobs") : undefined;
}

const evalResultEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  message: z.object({
    role: z.literal("toolResult"),
    toolName: z.literal("eval"),
    content: z.array(
      z.looseObject({
        type: z.string(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    ),
  }),
});

/** One persisted `eval` tool result: its image blocks as blob references. */
function parseEvalResult(
  line: string,
): { id: string; at: number; blobs: ScreenshotBlob[] } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const entry = evalResultEntrySchema.safeParse(json);
  if (!entry.success) return undefined;
  const blobs = entry.data.message.content.flatMap((block): ScreenshotBlob[] => {
    const hash = block.type === "image" ? BLOB_REFERENCE.exec(block.data ?? "")?.[1] : undefined;
    const mimeType = block.mimeType ?? "";
    return hash && isOmpImageMimeType(mimeType) ? [{ hash, mimeType }] : [];
  });
  return { id: entry.data.id, at: Date.parse(entry.data.timestamp), blobs };
}

function copyToCache(
  directory: string,
  blob: ScreenshotBlob,
  cache: OmpImageCache,
): string | undefined {
  const bytes = readRegularFile(join(directory, blob.hash), MAX_CACHED_IMAGE_BYTES);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== blob.hash) return undefined;
  // Only the magic bytes are checked, so encode only the header (12 bytes are 16 characters).
  if (!isValidImagePayload(bytes.subarray(0, 12).toString("base64"), blob.mimeType, 16)) {
    return undefined;
  }
  return cache.store(bytes, blob.mimeType);
}

/**
 * The `eval` screenshots of the turn between `since` and `until` (epoch ms). OMP persists each as
 * a content-addressed blob next to its sessions; they are copied into the image cache so the
 * row can name them by cache reference and the stock image renderer shows them.
 */
export async function readOmpScreenshots(
  sessionFile: string,
  since: number,
  until: number,
  cache: OmpImageCache,
): Promise<OmpTurnRow | undefined> {
  const directory = blobDirectory(sessionFile);
  if (!directory || !isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return;
  const tail = await readTail(sessionFile);
  if (!tail) return;
  let id: string | undefined;
  const blobs: ScreenshotBlob[] = [];
  for (const line of tail.split("\n")) {
    if (!line.includes("blob:sha256:")) continue;
    const result = parseEvalResult(line);
    if (!result || !(result.at >= since && result.at <= until) || result.blobs.length === 0)
      continue;
    id ??= result.id;
    blobs.push(...result.blobs);
  }
  if (!id) return;
  const unique = new Map(blobs.map((blob) => [blob.hash, blob]));
  const images = [...unique.values()].slice(0, MAX_SCREENSHOTS).flatMap((blob) => {
    const ref = copyToCache(directory, blob, cache);
    return ref ? [{ id: ref.slice(0, 16), ref, mimeType: blob.mimeType }] : [];
  });
  if (images.length === 0) return;
  return {
    id: `screenshots:${id}`,
    kind: OMP_IMAGE_TIMELINE_KIND,
    data: ompImageTimelineSchema.parse({ label: LABEL, images }),
  };
}

/** Paseo's bundled `omp` provider keeps only the text of `eval`, so its screenshots are read from the session file. */
export function ompScreenshotRow(
  sessionFile: string,
  since: number,
  until: number,
): Promise<OmpTurnRow | undefined> {
  return readOmpScreenshots(sessionFile, since, until, ompImageCache());
}
