/** Per-instance display context reaches native CLI children without changing host or session authority. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(launchEnvironment?: Readonly<Record<string, string>>) {
  const directory = await mkdtemp("/tmp/printstream-runtime-env-");
  temporary.push(directory);
  const binary = join(directory, "owned-cli");
  await writeFile(
    binary,
    "#!" +
      process.execPath +
      '\nif(process.argv.includes("--version")){console.log("0.38.2");}else{console.log(JSON.stringify({display:process.env.DISPLAY??null,authority:process.env.XAUTHORITY??null,wayland:process.env.WAYLAND_DISPLAY??null,socket:process.env.AGENT_BROWSER_SOCKET_DIR,profile:process.env.AGENT_BROWSER_PROFILE??null,args:process.argv.slice(2)}));}\n',
    { mode: 0o700 },
  );
  const runtime = new AgentBrowserRuntime({
    binaryPath: binary,
    executablePath: join(directory, "unlaunched-chromium"),
    profilePath: join(directory, "owned-profile"),
    ipcDirectory: join(directory, "owned-ipc"),
    session: "owned-environment",
    ...(launchEnvironment ? { launchEnvironment } : {}),
  });
  const native = runtime as unknown as {
    assertVersion(): Promise<void>;
    invoke(args: string[]): Promise<{
      display: string | null;
      authority: string | null;
      wayland: string | null;
      socket: string;
      profile: null;
      args: string[];
    }>;
  };
  return { directory, runtime, native };
}

describe("trusted private display launch environment", () => {
  it("passes display/auth to every CLI child, copies settings, and keeps host environment unchanged", async () => {
    const before = {
      display: process.env.DISPLAY,
      authority: process.env.XAUTHORITY,
      wayland: process.env.WAYLAND_DISPLAY,
    };
    const environment = { DISPLAY: ":24701", XAUTHORITY: "/tmp/owned-private-auth" };
    const f = await fixture(environment);
    environment.DISPLAY = ":24702";
    await f.native.assertVersion();
    for (const args of [["owned-request"], ["owned-reconnect"]]) {
      const result = await f.native.invoke(args);
      expect(result).toEqual({
        display: ":24701",
        authority: "/tmp/owned-private-auth",
        wayland: null,
        socket: join(f.directory, "owned-ipc"),
        profile: null,
        args,
      });
    }
    expect({
      display: process.env.DISPLAY,
      authority: process.env.XAUTHORITY,
      wayland: process.env.WAYLAND_DISPLAY,
    }).toEqual(before);
    await f.runtime.shutdown();
  });
  it("preserves the ordinary host display path when no private environment is provided", async () => {
    const f = await fixture();
    const result = await f.native.invoke(["ordinary"]);
    expect(result).toMatchObject({
      display: process.env.DISPLAY ?? null,
      authority: process.env.XAUTHORITY ?? null,
      wayland: process.env.WAYLAND_DISPLAY ?? null,
      socket: join(f.directory, "owned-ipc"),
    });
    await f.runtime.shutdown();
  });
  it("refuses missing, remote or extra values that could override managed IPC/profile/session identity", async () => {
    for (const value of [
      { DISPLAY: ":24701" },
      { DISPLAY: "remote.example:0", XAUTHORITY: "/tmp/auth" },
      { DISPLAY: ":24701", XAUTHORITY: "relative-auth" },
      { DISPLAY: ":24701", XAUTHORITY: "/tmp/auth", AGENT_BROWSER_SOCKET_DIR: "/tmp/other-ipc" },
      { DISPLAY: ":24701", XAUTHORITY: "/tmp/auth", HOME: "/tmp/other-home" },
    ]) {
      await expect(fixture(value)).rejects.toThrow("display environment is invalid");
    }
  });
});
