import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { z } from "zod";
import { OMP_IMAGE_TIMELINE_KIND, ompImageTimelineSchema } from "../shared/provider-image";
import { ompDataDir } from "./paths";
import { isOmpImageMimeType, isValidImagePayload, type OmpImageMimeType } from "./provider/image";
import { MAX_CACHED_IMAGE_BYTES, type OmpImageCache, ompImageCache } from "./provider/image-cache";
import { readRegularFile } from "./regular-file";
import { readTail } from "./rule-notices";
import type { OmpTurnRow } from "./turn-rows";

const BLOB_REFERENCE = /^blob:sha256:([0-9a-f]{64})$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
/** OMP moves image data of 1,024 or more base64 characters into a blob; shorter stays inline. */
const MAX_INLINE_BASE64_LENGTH = 1_023;
const MAX_SCREENSHOTS = 16;
const LABEL = "Screenshots";

interface ScreenshotImage {
  /** SHA-256 of the image bytes; names the blob file. */
  hash: string;
  mimeType: OmpImageMimeType;
  /** Present for an image persisted inline instead of as a blob. */
  bytes?: Buffer;
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

/** One persisted `eval` tool result: its image blocks, as blob references or small inline data. */
function parseEvalResult(
  line: string,
): { id: string; at: number; images: ScreenshotImage[] } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const entry = evalResultEntrySchema.safeParse(json);
  if (!entry.success) return undefined;
  const images = entry.data.message.content.flatMap((block): ScreenshotImage[] => {
    const mimeType = block.mimeType ?? "";
    const data = block.data ?? "";
    if (block.type !== "image" || !isOmpImageMimeType(mimeType)) return [];
    const hash = BLOB_REFERENCE.exec(data)?.[1];
    if (hash) return [{ hash, mimeType }];
    if (data.length > MAX_INLINE_BASE64_LENGTH || !BASE64.test(data)) return [];
    const bytes = Buffer.from(data, "base64");
    return [{ hash: createHash("sha256").update(bytes).digest("hex"), mimeType, bytes }];
  });
  return { id: entry.data.id, at: Date.parse(entry.data.timestamp), images };
}

function copyToCache(
  directory: string,
  image: ScreenshotImage,
  cache: OmpImageCache,
): string | undefined {
  const bytes = image.bytes ?? readRegularFile(join(directory, image.hash), MAX_CACHED_IMAGE_BYTES);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== image.hash) return undefined;
  // Only the magic bytes are checked, so encode only the header (12 bytes are 16 characters).
  if (!isValidImagePayload(bytes.subarray(0, 12).toString("base64"), image.mimeType, 16)) {
    return undefined;
  }
  return cache.store(bytes, image.mimeType);
}

/**
 * The `eval` screenshots of the turn between `since` and `until` (epoch ms). OMP persists each as
 * a content-addressed file in `blobDirectory` (or inline when it is tiny); they are copied into
 * the image cache so the row can name them by cache reference and the stock image renderer shows
 * them.
 */
export async function readOmpScreenshots(
  sessionFile: string,
  since: number,
  until: number,
  cache: OmpImageCache,
  blobDirectory: string,
): Promise<OmpTurnRow | undefined> {
  if (!isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return;
  const tail = await readTail(sessionFile);
  if (!tail) return;
  let id: string | undefined;
  const found: ScreenshotImage[] = [];
  for (const line of tail.split("\n")) {
    if (!line.includes("toolResult")) continue;
    const result = parseEvalResult(line);
    if (!result || !(result.at >= since && result.at <= until) || result.images.length === 0)
      continue;
    id ??= result.id;
    found.push(...result.images);
  }
  if (!id) return;
  const unique = new Map(found.map((image) => [image.hash, image]));
  const images: z.infer<typeof ompImageTimelineSchema>["images"] = [];
  for (const image of unique.values()) {
    if (images.length >= MAX_SCREENSHOTS) break;
    const ref = copyToCache(blobDirectory, image, cache);
    if (ref) images.push({ id: ref.slice(0, 16), ref, mimeType: image.mimeType });
    // Each copy reads and hashes up to 6 MiB synchronously; let other daemon work run between images.
    await yieldToEventLoop();
  }
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
  return readOmpScreenshots(
    sessionFile,
    since,
    until,
    ompImageCache(),
    join(ompDataDir(), "blobs"),
  );
}
