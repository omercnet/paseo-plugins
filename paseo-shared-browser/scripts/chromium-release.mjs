import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs `agent-browser install` against a private home and returns the
 * Chromium release directory it produced. agent-browser resolves its browser
 * cache with Rust's std::env::home_dir(): HOME on Unix and USERPROFILE on
 * Windows, so both point at installHome.
 */
export async function installChromiumRelease(agentBrowser, args, installHome) {
  await mkdir(installHome, { recursive: true, mode: 0o700 });
  await execFileAsync(agentBrowser, args, {
    env: { ...process.env, HOME: installHome, USERPROFILE: installHome },
    timeout: 180_000,
    windowsHide: true,
  });

  const browsersRoot = join(installHome, ".agent-browser", "browsers");
  const releases = (await readdir(browsersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chrome-"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (!releases[0]) throw new Error("agent-browser install did not produce a Chromium release");
  return join(browsersRoot, releases[0]);
}
