import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveGeneratedImages } from "../server/generated-images";
import { MAX_CACHED_IMAGE_BYTES, OmpImageCache, ompImageRef } from "../server/provider/image-cache";
import { transformOmpGeneratedImageItem } from "../shared/generated-image";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not a full image, only the header is checked"),
]);

function generateImageRow(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_call",
    callId: "call-img",
    name: "generate_image",
    status: "completed",
    error: null,
    detail: {
      type: "unknown",
      input: { subject: "a card" },
      output: {
        content: [{ type: "text", text: "Generated 1 image(s)" }],
        details: {
          provider: "xai",
          imagePaths: ["/tmp/omp-image-abc.png"],
          images: [{ data: "AAAA" }],
        },
      },
    },
    ...overrides,
  };
}

describe("generate_image row", () => {
  test("becomes a card keyed by its call id and naming the saved files", () => {
    expect(transformOmpGeneratedImageItem(generateImageRow())?.items).toEqual([
      {
        type: "plugin",
        kind: "omp-generated-images",
        id: "call-img",
        version: 1,
        data: { paths: ["/tmp/omp-image-abc.png"] },
      },
    ]);
  });

  test("keeps at most eight usable paths", () => {
    const imagePaths = [
      ...Array.from({ length: 10 }, (_, index) => `/tmp/omp-image-${index}.png`),
      `/${"x".repeat(2000)}`,
    ];
    const row = generateImageRow({
      detail: { type: "unknown", input: {}, output: { details: { imagePaths } } },
    });
    expect(transformOmpGeneratedImageItem(row)?.items[0]?.data.paths).toEqual(
      imagePaths.slice(0, 8),
    );
  });

  test.each([
    ["another tool", generateImageRow({ name: "read" })],
    ["a running call", generateImageRow({ status: "running" })],
    [
      "a result without paths",
      generateImageRow({ detail: { type: "unknown", input: {}, output: { details: {} } } }),
    ],
    [
      "an empty path list",
      generateImageRow({
        detail: { type: "unknown", input: {}, output: { details: { imagePaths: [] } } },
      }),
    ],
    ["a plain text row", generateImageRow({ detail: { type: "plain_text", text: "x" } })],
  ])("keeps the original row for %s", (_name, row) => {
    expect(transformOmpGeneratedImageItem(row)).toBeUndefined();
  });
});

describe("resolveGeneratedImages", () => {
  let root: string;
  let temp: string;
  let cache: OmpImageCache;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-generated-test-"));
    temp = join(root, "tmp");
    mkdirSync(temp);
    vi.stubEnv("TMPDIR", temp);
    cache = new OmpImageCache(join(root, "cache"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function resolve(...paths: string[]) {
    return resolveGeneratedImages({ paths }, cache).images;
  }

  test("copies a generated file into the image cache and returns its reference", () => {
    const path = join(temp, "omp-image-abc123.png");
    writeFileSync(path, PNG);
    expect(resolve(path)).toEqual([
      { status: "available", ref: ompImageRef(PNG), mimeType: "image/png" },
    ]);
    expect(cache.read(ompImageRef(PNG), "image/png")?.equals(PNG)).toBe(true);
  });

  test("refuses anything that is not a regular omp-image file in the temp directory", () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    const secret = join(outside, "omp-image-outside.png");
    writeFileSync(secret, PNG);
    writeFileSync(join(temp, "notes.png"), PNG);
    writeFileSync(join(temp, "omp-image-text.png"), "plain text, not an image");
    writeFileSync(join(temp, "omp-image-wrongtype.jpg"), PNG);
    symlinkSync(secret, join(temp, "omp-image-link.png"));
    mkdirSync(join(temp, "omp-image-dir.png"));
    const refused = [
      secret,
      join(temp, "notes.png"),
      join(temp, "omp-image-text.png"),
      join(temp, "omp-image-wrongtype.jpg"),
      join(temp, "omp-image-link.png"),
      join(temp, "omp-image-dir.png"),
      join(temp, "omp-image-absent.png"),
      join(temp, "..", "tmp", "..", "elsewhere", "omp-image-outside.png"),
      "omp-image-relative.png",
    ];
    expect(resolve(...refused)).toEqual(refused.map(() => ({ status: "missing" })));
  });

  test.skipIf(process.platform === "win32")("does not hang on a FIFO named like an image", () => {
    const fifo = join(temp, "omp-image-fifo.png");
    execFileSync("mkfifo", [fifo]);
    expect(resolve(fifo)).toEqual([{ status: "missing" }]);
  });

  test("refuses a file over the cache size limit", () => {
    const path = join(temp, "omp-image-huge.png");
    writeFileSync(path, Buffer.concat([PNG, Buffer.alloc(MAX_CACHED_IMAGE_BYTES)]));
    expect(resolve(path)).toEqual([{ status: "missing" }]);
  });

  test.skipIf(process.platform === "win32")(
    "accepts a file when the temp directory is reached through a symlink",
    () => {
      const link = join(root, "tmp-link");
      symlinkSync(temp, link);
      vi.stubEnv("TMPDIR", link);
      const path = join(temp, "omp-image-linked.png");
      writeFileSync(path, PNG);
      expect(resolve(path)).toEqual([
        { status: "available", ref: ompImageRef(PNG), mimeType: "image/png" },
      ]);
    },
  );
});
