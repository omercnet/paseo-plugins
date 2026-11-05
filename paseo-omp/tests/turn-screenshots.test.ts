import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OmpImageCache } from "../server/provider/image-cache";
import { readOmpScreenshots } from "../server/turn-screenshots";
import { ompImageTimelineSchema } from "../shared/provider-image";

const SINCE = Date.parse("2026-11-05T09:10:00.000Z");
const UNTIL = Date.parse("2026-11-05T09:10:30.000Z");

function png(label: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label),
  ]);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function toolResult(id: string, timestamp: string, content: object[], toolName = "eval") {
  return { type: "message", id, timestamp, message: { role: "toolResult", toolName, content } };
}

function image(hash: string, mimeType = "image/png") {
  return { type: "image", data: `blob:sha256:${hash}`, mimeType };
}

describe("OMP turn screenshots", () => {
  let root: string;
  let agentDirectory: string;
  let cache: OmpImageCache;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-screenshots-test-"));
    agentDirectory = join(root, "agent");
    mkdirSync(join(agentDirectory, "sessions", "project"), { recursive: true });
    mkdirSync(join(agentDirectory, "blobs"));
    cache = new OmpImageCache(join(root, "cache"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function blob(bytes: Buffer, name = sha256(bytes)): string {
    writeFileSync(join(agentDirectory, "blobs", name), bytes);
    return sha256(bytes);
  }

  function session(entries: object[]): string {
    const file = join(agentDirectory, "sessions", "project", "session.jsonl");
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return file;
  }

  test("turns the eval screenshots of the turn into one image row backed by the image cache", async () => {
    const first = png("first screenshot");
    const second = png("second screenshot");
    const file = session([
      toolResult("old", "2026-11-05T09:00:00.000Z", [image(blob(png("earlier turn")))]),
      toolResult("shot-1", "2026-11-05T09:10:05.000Z", [
        { type: "text", text: "<image image/png>" },
        image(blob(first)),
      ]),
      toolResult("shot-2", "2026-11-05T09:10:06.000Z", [image(blob(second)), image(blob(first))]),
    ]);

    const row = await readOmpScreenshots(file, SINCE, UNTIL, cache);

    expect(row?.id).toBe("screenshots:shot-1");
    expect(row?.kind).toBe("omp-images");
    expect(row?.data).toEqual({
      label: "Screenshots",
      images: [first, second].map((bytes) => ({
        id: sha256(bytes).slice(0, 16),
        ref: sha256(bytes),
        mimeType: "image/png",
      })),
    });
    expect(cache.read(sha256(first), "image/png")?.equals(first)).toBe(true);
    expect(cache.read(sha256(second), "image/png")?.equals(second)).toBe(true);
  });

  test("skips results that are not eval screenshots of this turn", async () => {
    const bytes = png("kept");
    const file = session([
      toolResult("other-tool", "2026-11-05T09:10:05.000Z", [image(blob(png("other")))], "read"),
      toolResult("late", "2026-11-05T09:11:00.000Z", [image(blob(png("late")))]),
      toolResult("text-only", "2026-11-05T09:10:06.000Z", [{ type: "text", text: "no image" }]),
      toolResult("kept", "2026-11-05T09:10:08.000Z", [image(blob(bytes))]),
    ]);

    const row = await readOmpScreenshots(file, SINCE, UNTIL, cache);

    expect(row?.id).toBe("screenshots:kept");
    expect(ompImageTimelineSchema.parse(row?.data).images).toHaveLength(1);
  });

  test("keeps a tiny image that OMP persisted inline instead of as a blob", async () => {
    const bytes = png("tiny inline image");
    const file = session([
      toolResult("inline", "2026-11-05T09:10:07.000Z", [
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ]),
    ]);

    const row = await readOmpScreenshots(file, SINCE, UNTIL, cache);

    expect(row?.id).toBe("screenshots:inline");
    expect(ompImageTimelineSchema.parse(row?.data).images).toEqual([
      { id: sha256(bytes).slice(0, 16), ref: sha256(bytes), mimeType: "image/png" },
    ]);
    expect(cache.read(sha256(bytes), "image/png")?.equals(bytes)).toBe(true);
  });

  test("ignores inline data that is not a small, valid image", async () => {
    const file = session([
      toolResult("not-image", "2026-11-05T09:10:07.000Z", [
        {
          type: "image",
          data: Buffer.from("plain text").toString("base64"),
          mimeType: "image/png",
        },
      ]),
      toolResult("too-big", "2026-11-05T09:10:08.000Z", [
        {
          type: "image",
          data: Buffer.concat([png("x"), Buffer.alloc(2_000)]).toString("base64"),
          mimeType: "image/png",
        },
      ]),
      toolResult("bad-base64", "2026-11-05T09:10:09.000Z", [
        { type: "image", data: "not base64!!", mimeType: "image/png" },
      ]),
    ]);

    expect(await readOmpScreenshots(file, SINCE, UNTIL, cache)).toBeUndefined();
  });

  test("drops blobs that are missing, altered, not images or symlinks", async () => {
    const missing = sha256(png("missing"));
    const altered = sha256(png("claimed"));
    writeFileSync(join(agentDirectory, "blobs", altered), png("different bytes"));
    const text = Buffer.from("plain text, not an image");
    const target = join(root, "outside.png");
    writeFileSync(target, png("outside"));
    const linked = sha256(png("outside"));
    symlinkSync(target, join(agentDirectory, "blobs", linked));
    const file = session([
      toolResult("bad", "2026-11-05T09:10:05.000Z", [
        image(missing),
        image(altered),
        image(blob(text)),
        image(linked),
      ]),
    ]);

    expect(await readOmpScreenshots(file, SINCE, UNTIL, cache)).toBeUndefined();
  });

  test("refuses a session file outside an agent sessions directory", async () => {
    const file = join(root, "session.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify(toolResult("shot", "2026-11-05T09:10:05.000Z", [image(blob(png("x")))]))}\n`,
    );
    expect(await readOmpScreenshots(file, SINCE, UNTIL, cache)).toBeUndefined();
    expect(
      await readOmpScreenshots("sessions/project/session.jsonl", SINCE, UNTIL, cache),
    ).toBeUndefined();
  });

  test("counts only images that were copied toward the per-turn limit", async () => {
    const missing = Array.from({ length: 17 }, (_, index) => sha256(png(`missing ${index}`)));
    const valid = Array.from({ length: 18 }, (_, index) => png(`valid ${index}`));
    const file = session([
      toolResult("many", "2026-11-05T09:10:05.000Z", [
        ...missing.map((hash) => image(hash)),
        ...valid.map((bytes) => image(blob(bytes))),
      ]),
    ]);

    const row = await readOmpScreenshots(file, SINCE, UNTIL, cache);

    const images = ompImageTimelineSchema.parse(row?.data).images;
    expect(images).toHaveLength(16);
    const refs = images.map((entry) => ("ref" in entry ? entry.ref : undefined));
    expect(refs).toEqual(valid.slice(0, 16).map(sha256));
  });
});
