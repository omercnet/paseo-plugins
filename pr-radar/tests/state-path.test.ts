import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acknowledgeViewerUpdates } from "../server/viewer-scope";

const relative = join("plugin-data", "pr-radar", "inbox-state.json");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pr-radar-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true })));
});

describe("inbox state location", () => {
  test("writes under PASEO_HOME with private mode", async () => {
    const paseoHome = await temporaryDirectory();
    vi.stubEnv("PASEO_HOME", paseoHome);
    const { acknowledgedAt } = await acknowledgeViewerUpdates({ windowDays: 7 });
    const path = join(paseoHome, relative);
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state.windows["7"].acknowledgedAt).toBe(acknowledgedAt);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("falls back to ~/.paseo when PASEO_HOME is unset", async () => {
    const home = await temporaryDirectory();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("PASEO_HOME", "");
    delete process.env.PASEO_HOME;
    await acknowledgeViewerUpdates({ windowDays: 7 });
    await expect(readFile(join(home, ".paseo", relative), "utf8")).resolves.toContain(
      '"version":2',
    );
  });
});
