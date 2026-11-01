import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  OmpImageCache,
  ompImageCacheDir,
  ompImageRef,
  resolveGetOmpImage,
} from "../server/provider/image-cache";
import { getOmpImage, ompImageRefetchInterval, ompImageStaleTime } from "../shared/provider-image";

const PNG_HEADER = Buffer.from("89504e470d0a1a0a", "hex");

function png(fill: number, size = 64): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, fill)]);
}

let root: string;
let directory: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-omp-image-cache-"));
  directory = join(root, "images");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function setAge(cache: OmpImageCache, ref: string, secondsAgo: number): void {
  const time = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(join(cache.directory, `${ref}.png`), time, time);
}

describe("OMP image cache", () => {
  test("stores private content-addressed files and reads them back", () => {
    const cache = new OmpImageCache(directory);
    const bytes = png(1);
    const ref = cache.store(bytes, "image/png");
    expect(ref).toBe(ompImageRef(bytes));
    expect(ref).toMatch(/^[0-9a-f]{64}$/u);
    expect(readdirSync(directory)).toEqual([`${ref}.png`]);
    // Windows has no POSIX permission bits; Node reports 0o666 there regardless of the mode.
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, `${ref}.png`)).mode & 0o777).toBe(0o600);
    }
    expect(cache.read(ref, "image/png")).toEqual(bytes);
    expect(cache.store(bytes, "image/png")).toBe(ref);
    expect(readdirSync(directory)).toEqual([`${ref}.png`]);
  });

  test("serves images through the RPC and reports missing images", () => {
    const cache = new OmpImageCache(directory);
    const bytes = png(2);
    const ref = cache.store(bytes, "image/png");
    expect(resolveGetOmpImage({ ref, mimeType: "image/png" }, cache)).toEqual({
      status: "available",
      data: bytes.toString("base64"),
    });
    rmSync(join(directory, `${ref}.png`));
    expect(resolveGetOmpImage({ ref, mimeType: "image/png" }, cache)).toEqual({
      status: "missing",
    });
    expect(resolveGetOmpImage({ ref, mimeType: "image/webp" }, cache)).toEqual({
      status: "missing",
    });
  });

  test("rejects malformed references before touching the file system", () => {
    const cache = new OmpImageCache(directory);
    const ref = cache.store(png(3), "image/png");
    for (const candidate of [
      ref.toUpperCase(),
      ref.slice(1),
      `${ref}0`,
      `../${ref.slice(3)}`,
      "../../../../etc/passwd",
      `${ref.slice(0, 60)}/../`,
    ]) {
      expect(cache.read(candidate, "image/png")).toBeUndefined();
      expect(getOmpImage.input.safeParse({ ref: candidate, mimeType: "image/png" }).success).toBe(
        false,
      );
    }
    expect(getOmpImage.input.safeParse({ ref, mimeType: "image/png" }).success).toBe(true);
    expect(getOmpImage.input.safeParse({ ref, mimeType: "image/svg+xml" }).success).toBe(false);
    expect(
      getOmpImage.input.safeParse({ ref, mimeType: "image/png", path: "/etc/passwd" }).success,
    ).toBe(false);
  });

  test("refuses symlinks and files whose content does not match the reference", () => {
    const cache = new OmpImageCache(directory);
    const bytes = png(4);
    const ref = ompImageRef(bytes);
    mkdirSync(directory, { recursive: true });
    const outside = join(root, "outside.png");
    writeFileSync(outside, bytes);
    symlinkSync(outside, join(directory, `${ref}.png`));
    expect(cache.read(ref, "image/png")).toBeUndefined();

    const other = png(5);
    const otherRef = ompImageRef(other);
    writeFileSync(join(directory, `${otherRef}.png`), png(6));
    expect(cache.read(otherRef, "image/png")).toBeUndefined();
  });

  test("skips images above the per-image limit", () => {
    const cache = new OmpImageCache(directory, { maxImageBytes: 32, maxBytes: 1024, maxFiles: 8 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = cache.store(png(7, 33), "image/png");
    expect(ref).toBe(ompImageRef(png(7, 33)));
    expect(cache.read(ref, "image/png")).toBeUndefined();
    expect(existsSync(join(directory, `${ref}.png`))).toBe(false);
    expect(error).toHaveBeenCalledOnce();
  });

  test("evicts the least recently used images past the file count limit", () => {
    const cache = new OmpImageCache(directory, { maxImageBytes: 64, maxBytes: 4096, maxFiles: 2 });
    const first = cache.store(png(8), "image/png");
    setAge(cache, first, 30);
    const second = cache.store(png(9), "image/png");
    setAge(cache, second, 20);
    // Reading the oldest image marks it as recently used.
    expect(cache.read(first, "image/png")).toBeDefined();
    const third = cache.store(png(10), "image/png");
    expect(cache.read(first, "image/png")).toBeDefined();
    expect(cache.read(second, "image/png")).toBeUndefined();
    expect(cache.read(third, "image/png")).toBeDefined();
  });

  test("evicts the oldest images past the total size limit but keeps the new one", () => {
    const cache = new OmpImageCache(directory, { maxImageBytes: 64, maxBytes: 128, maxFiles: 8 });
    const first = cache.store(png(11), "image/png");
    setAge(cache, first, 30);
    const second = cache.store(png(12), "image/png");
    setAge(cache, second, 20);
    const third = cache.store(png(13), "image/png");
    expect(readdirSync(directory).sort()).toEqual([`${second}.png`, `${third}.png`].sort());

    const tiny = new OmpImageCache(join(root, "tiny"), {
      maxImageBytes: 64,
      maxBytes: 16,
      maxFiles: 8,
    });
    const kept = tiny.store(png(14), "image/png");
    expect(tiny.read(kept, "image/png")).toBeDefined();
  });

  test("returns the reference without writing when the directory is unsafe or unwritable", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, directory);
    const linked = new OmpImageCache(directory);
    const bytes = png(15);
    expect(linked.store(bytes, "image/png")).toBe(ompImageRef(bytes));
    expect(readdirSync(target)).toEqual([]);

    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    expect(new OmpImageCache(join(blocked, "images")).store(bytes, "image/png")).toBe(
      ompImageRef(bytes),
    );
    expect(error).toHaveBeenCalledTimes(2);
  });

  test("rewrites a damaged cache file when the image is stored again", () => {
    const cache = new OmpImageCache(directory);
    const bytes = png(16);
    const ref = cache.store(bytes, "image/png");
    truncateSync(join(directory, `${ref}.png`), 0);
    expect(cache.read(ref, "image/png")).toBeUndefined();
    expect(cache.store(bytes, "image/png")).toBe(ref);
    expect(cache.read(ref, "image/png")).toEqual(bytes);

    // Same size, different content: the hash check rejects it and storing again repairs it.
    writeFileSync(join(directory, `${ref}.png`), png(20));
    expect(cache.read(ref, "image/png")).toBeUndefined();
    expect(cache.store(bytes, "image/png")).toBe(ref);
    expect(cache.read(ref, "image/png")).toEqual(bytes);
  });

  test("refuses to read through a cache directory replaced by a symlink", () => {
    const bytes = png(21);
    const target = join(root, "elsewhere");
    mkdirSync(target);
    const ref = ompImageRef(bytes);
    writeFileSync(join(target, `${ref}.png`), bytes);
    symlinkSync(target, directory, "dir");
    expect(new OmpImageCache(directory).read(ref, "image/png")).toBeUndefined();
  });

  test("sweeps stale temp files left by an interrupted write", () => {
    const cache = new OmpImageCache(directory);
    mkdirSync(directory, { recursive: true });
    const ref = ompImageRef(png(17));
    const stale = join(directory, `.${ref}.0123456789abcdef.tmp`);
    const fresh = join(directory, `.${ref}.fedcba9876543210.tmp`);
    writeFileSync(stale, "partial");
    writeFileSync(fresh, "in flight");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(stale, old, old);
    const stored = cache.store(png(18), "image/png");
    expect(readdirSync(directory).sort()).toEqual(
      [`.${ref}.fedcba9876543210.tmp`, `${stored}.png`].sort(),
    );
  });

  // Windows has no FIFOs in the file system.
  test.skipIf(process.platform === "win32")("does not block on a FIFO named like an image", () => {
    const cache = new OmpImageCache(directory);
    mkdirSync(directory, { recursive: true });
    const ref = ompImageRef(png(19));
    execFileSync("mkfifo", [join(directory, `${ref}.png`)]);
    expect(cache.read(ref, "image/png")).toBeUndefined();
  });

  test("keeps available images fresh but refetches missing ones", () => {
    expect(ompImageStaleTime({ status: "available", data: "iVBORw0KGgo=" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(ompImageStaleTime({ status: "missing" })).toBe(0);
    expect(ompImageStaleTime(undefined)).toBe(0);
    expect(ompImageRefetchInterval({ status: "missing" }, 1)).toBe(15_000);
    expect(ompImageRefetchInterval({ status: "missing" }, 9)).toBe(false);
    expect(ompImageRefetchInterval({ status: "available", data: "iVBORw0KGgo=" }, 1)).toBe(false);
    expect(ompImageRefetchInterval(undefined, 0)).toBe(false);
  });

  test("resolves the cache under the daemon's Paseo home", () => {
    expect(ompImageCacheDir({ PASEO_HOME: "/srv/paseo" })).toBe(
      join(resolve("/srv/paseo"), "plugin-data", "paseo-omp", "images"),
    );
    expect(ompImageCacheDir({ PASEO_HOME: "~/isolated" })).toBe(
      join(homedir(), "isolated", "plugin-data", "paseo-omp", "images"),
    );
    expect(ompImageCacheDir({})).toBe(
      join(homedir(), ".paseo", "plugin-data", "paseo-omp", "images"),
    );
  });
});
