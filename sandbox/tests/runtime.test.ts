import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DOCKERFILE, IMAGE_TAG } from "../server/docker/image";

const file = readFileSync(join(import.meta.dirname, "../runtime/Dockerfile"), "utf8");

describe("runtime image", () => {
  test("the embedded Dockerfile is the shipped runtime/Dockerfile", () => {
    // The plugin bundle cannot read files, so a stale copy would build the wrong image.
    expect(DOCKERFILE).toBe(file);
    expect(IMAGE_TAG).toMatch(/^paseo-sandbox:[0-9a-f]{12}$/);
  });

  test("the base image is pinned by digest and nothing secret is baked in", () => {
    expect(file).toMatch(
      /^FROM ghcr\.io\/getpaseo\/paseo:\$\{PASEO_VERSION\}@sha256:[0-9a-f]{64}$/m,
    );
    expect(file).not.toMatch(/^(ARG|ENV)\s+\w*(TOKEN|KEY|PASSWORD|SECRET)/im);
    expect(file).not.toMatch(/^USER\s+(?!root$)/m);
  });
});
