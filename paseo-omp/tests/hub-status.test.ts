import { describe, expect, test } from "bun:test";
import { hubProcessTone, summarizeHubProcesses } from "../client/hub-status";
import { type HubProcess, tailHubLog } from "../shared/hub";

function process(state: string, exitCode: number | null = null): HubProcess {
  return {
    name: "server",
    application: "bun",
    args: [],
    cwd: "/workspace",
    state,
    owner: null,
    restartCount: 0,
    persist: false,
    detached: false,
    createdAt: null,
    startedAt: null,
    readyAt: null,
    exitedAt: null,
    exitCode,
  };
}

describe("hub process presentation", () => {
  test("distinguishes active, transitional, successful, and failed processes", () => {
    expect(hubProcessTone(process("running"))).toBe("success");
    expect(hubProcessTone(process("starting"))).toBe("warning");
    expect(hubProcessTone(process("exited", 0))).toBe("muted");
    expect(hubProcessTone(process("exited", 1))).toBe("danger");
  });

  test("hides empty pills and marks any failing process", () => {
    expect(summarizeHubProcesses([])).toEqual({ visible: false, label: "Hub" });
    expect(summarizeHubProcesses([process("running"), process("failed")])).toEqual({
      visible: true,
      label: "Hub · 2 !",
    });
  });
});

describe("hub RPC boundaries", () => {
  test("rejects process names that can escape the daemon directory", () => {
    expect(
      tailHubLog.input.safeParse({ cwd: "/workspace", name: "../../scope.json" }).success,
    ).toBe(false);
    expect(
      tailHubLog.input.safeParse({ cwd: "/workspace", name: "omp.browser.headless" }).success,
    ).toBe(true);
  });
});
