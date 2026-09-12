import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import packageJson from "../package.json";

const pluginRoot = join(import.meta.dirname, "..");

async function collectFiles(path: string, files: string[]): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isFile()) {
    files.push(relative(pluginRoot, path).replaceAll("\\", "/"));
    return;
  }
  for (const entry of await readdir(path)) await collectFiles(join(path, entry), files);
}

function findBrokenMarkdownLinks(archive: Record<string, Uint8Array>): string[] {
  const broken: string[] = [];
  const decoder = new TextDecoder();
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;

  for (const [path, contents] of Object.entries(archive)) {
    if (!path.endsWith(".md")) continue;
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
      const child = Bun.spawn(["bun", "scripts/package-release.ts", archivePath], {
        cwd: pluginRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);

      const archive = unzipSync(new Uint8Array(await Bun.file(archivePath).arrayBuffer()));

      const expectedFiles: string[] = ["package.json"];
      for (const path of packageJson.files)
        await collectFiles(join(pluginRoot, path), expectedFiles);
      expect(Object.keys(archive).sort()).toEqual(
        expectedFiles.map((path) => `paseo-omp/${path}`).sort(),
      );
      expect(findBrokenMarkdownLinks(archive)).toEqual([]);
      expect(archive["paseo-omp/server/provider/host-tools.ts"]).toBeDefined();
      expect(archive["paseo-omp/server/provider/mcp-transport.ts"]).toBeDefined();
      expect(archive["paseo-omp/server/provider/security.ts"]).toBeDefined();
      const extractedRoot = join(temporaryDirectory, "extracted");
      for (const [path, contents] of Object.entries(archive)) {
        const destination = join(extractedRoot, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, contents);
      }
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
  });
});
