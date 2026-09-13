import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json";
import { extractArchiveFiles } from "../scripts/release-archive";

const pluginRoot = join(import.meta.dirname, "..");
const executeFile = promisify(execFile);

async function trackedPackageFiles(): Promise<string[]> {
  const { stdout } = await executeFile("git", ["ls-files", "--cached", "-z", "--", "."], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  const roots = ["package.json", ...packageJson.files];
  return stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)))
    .sort();
}

function findBrokenMarkdownLinks(archive: Record<string, Uint8Array>): string[] {
  const broken: string[] = [];
  const decoder = new TextDecoder();
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;

  for (const [path, contents] of Object.entries(archive)) {
    if (!/^paseo-omp\/[^/]+\.md$/u.test(path)) continue;
    for (const match of decoder.decode(contents).matchAll(linkPattern)) {
      const href = match[1];
      if (!href || /^(?:https?:|mailto:|#)/u.test(href)) continue;
      const target = decodeURIComponent(href.split("#", 1)[0]?.split("?", 1)[0] ?? "");
      if (!target) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (!Object.hasOwn(archive, resolved)) broken.push(`${path} -> ${href}`);
    }
  }

  return broken;
}

describe("release package", () => {
  test("contains the host-tools bridge and a complete server module graph", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-release-"));
    const archivePath = join(temporaryDirectory, "paseo-omp.zip");
    try {
      await executeFile(
        process.execPath,
        ["--import", "tsx", "scripts/package-release.ts", archivePath],
        {
          cwd: pluginRoot,
        },
      );

      const archive = unzipSync(await readFile(archivePath));

      const expectedFiles = (await trackedPackageFiles()).map((path) => `paseo-omp/${path}`);
      const localArchiveFiles = Object.keys(archive)
        .filter((path) => !path.startsWith("paseo-omp/node_modules/"))
        .sort();
      expect(localArchiveFiles).toEqual(expectedFiles);
      expect(
        archive["paseo-omp/node_modules/@modelcontextprotocol/sdk/package.json"],
      ).toBeDefined();
      expect(archive["paseo-omp/node_modules/@getpaseo/client/package.json"]).toBeDefined();
      expect(archive["paseo-omp/node_modules/@getpaseo/plugin/package.json"]).toBeDefined();
      expect(archive["paseo-omp/node_modules/yaml/package.json"]).toBeDefined();
      expect(archive["paseo-omp/node_modules/typescript/package.json"]).toBeUndefined();
      expect(findBrokenMarkdownLinks(archive)).toEqual([]);
      expect(archive["paseo-omp/server/provider/host-tools.ts"]).toBeDefined();
      expect(archive["paseo-omp/server/provider/mcp-transport.ts"]).toBeDefined();
      expect(archive["paseo-omp/server/provider/security.ts"]).toBeDefined();
      const extractedRoot = join(temporaryDirectory, "extracted");
      await extractArchiveFiles(archive, extractedRoot);
      const result = await build({
        entryPoints: [join(extractedRoot, "paseo-omp/index.server.ts")],
        bundle: true,
        format: "esm",
        platform: "node",
        packages: "external",
        target: "node20",
        write: false,
        logLevel: "silent",
      });
      expect(result.errors).toEqual([]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  test("rejects ZIP entries outside the extraction root", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-zip-slip-"));
    try {
      await expect(
        extractArchiveFiles({ "../outside": new Uint8Array([1]) }, temporaryDirectory),
      ).rejects.toThrow(/ZIP entry/u);
      await expect(
        extractArchiveFiles({ "nested\\outside": new Uint8Array([1]) }, temporaryDirectory),
      ).rejects.toThrow(/ZIP entry/u);
      await expect(
        extractArchiveFiles({ "C:/outside": new Uint8Array([1]) }, temporaryDirectory),
      ).rejects.toThrow(/ZIP entry/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
