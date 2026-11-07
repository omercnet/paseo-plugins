import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

// Mirrors agent-browser's Rust std::env::home_dir(): HOME on Unix, USERPROFILE
// on Windows. The variable is passed in so both platforms run everywhere.
const fakeInstaller = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const home = process.env[process.argv[2]];
mkdirSync(join(home, ".agent-browser", "browsers", "chrome-150.0.7871.0"), { recursive: true });
`;

async function installChromiumRelease(
  homeVariable: string,
  installer: string,
  installHome: string,
): Promise<string> {
  const script = new URL("../scripts/chromium-release.mjs", import.meta.url).href;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { installChromiumRelease } from ${JSON.stringify(script)}; process.stdout.write(await installChromiumRelease(process.execPath, [process.argv[1], process.argv[2]], process.argv[3]));`,
      installer,
      homeVariable,
      installHome,
    ],
    { encoding: "utf8" },
  );
  return stdout;
}

describe("installChromiumRelease", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "shared-browser-chromium-"));
    vi.stubEnv("HOME", join(root, "account-home"));
    vi.stubEnv("USERPROFILE", join(root, "account-home"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["HOME", "USERPROFILE"])(
    "returns the release installed under a %s-resolved private home",
    async (homeVariable) => {
      const installer = join(root, "installer.mjs");
      await writeFile(installer, fakeInstaller);
      const installHome = join(root, "install-home");

      await expect(installChromiumRelease(homeVariable, installer, installHome)).resolves.toBe(
        join(installHome, ".agent-browser", "browsers", "chrome-150.0.7871.0"),
      );
    },
  );
});
