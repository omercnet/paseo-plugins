import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { unzipSync } from "fflate";

const pluginRoot = join(import.meta.dirname, "..");

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
