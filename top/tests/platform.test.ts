import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  defaultScan,
  parseCpuTime,
  parsePs,
  parsePsAgentId,
  parseWindows,
  readPsProcs,
  readWindowsProcs,
  WINDOWS_SCRIPT,
} from "../server/platform";
import { attribute, type ProcInfo } from "../server/processes";

/** `ps -axww -o pid=,ppid=,lstart=,cputime=,rss=,comm=` as a macOS runner printed it. */
const PS_STATS = `
    1     0 Sat Oct 10 05:12:44 2026       3:21.07   9344 /sbin/launchd
 1560     1 Tue Oct 13 06:01:17 2026       0:01.42  49264 /opt/homebrew/Cellar/node@24/24.20.0/bin/node
 1561  1560 Tue Oct  3 06:01:17 2026    1:02:03.45  48944 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
 1563     1 Tue Oct 13 06:01:17 2026       0:00.00      0 (node)
 1570     1 Tue Oct 13 06:01:18 2026    2-03:04:05  20480 /usr/bin/grep
garbage that is not a process row
`;

/** `ps -axww -E -o pid=,command=`: the environment follows the arguments, when it can be read. */
const PS_ENV = `
    1 /sbin/launchd
 1560 /opt/homebrew/bin/node -e work PATH=/usr/bin HOME=/Users/runner PASEO_AGENT_ID=agent-a TOKEN=hunter2
 1561 /Applications/Visual Studio Code.app/Contents/MacOS/Electron PASEO_AGENT_ID=agent-b
 1563 /opt/homebrew/bin/node PATH=/usr/bin
 1570 grep PASEO_AGENT_ID=agent-decoy
`;

/** Creation time in milliseconds, which stays exact as a JavaScript number. */
const STARTED = 1_792_000_000_000;

/** The tab separated lines the Windows script prints; the idle process and a stale parent included. */
const WINDOWS_ROWS = [
  ["0", "0", "0", "99999999999", "8192", "", "System Idle Process"],
  ["4", "0", `${STARTED - 500_000}`, "312500", "139264", "", "System"],
  ["2472", "6200", `${STARTED}`, "15781250", "34095104", "agent-a", "node.exe"],
  // Its parent's pid now belongs to a process that started after it did, so it is not its parent.
  ["6216", "2472", `${STARTED - 10_000}`, "625000", "33353728", "", "Node.EXE"],
  ["7000", "6216", `${STARTED - 5_000}`, "100000", "1000", "", "cmd.exe"],
  ["8000", "4", `${STARTED + 1}`, "0", "0", "", "Code Helper (Renderer)"],
]
  .map((row) => row.join("\t"))
  .join("\n");

describe("parseCpuTime", () => {
  it("reads minutes, hours and days, in clock ticks", () => {
    expect(parseCpuTime("0:01.42")).toBe(142);
    expect(parseCpuTime("12:00.00")).toBe(72_000);
    expect(parseCpuTime("1:02:03.45")).toBe((3600 + 120 + 3.45) * 100);
    expect(parseCpuTime("2-03:04:05")).toBe(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 100);
    expect(parseCpuTime("3:07")).toBe(18_700);
  });

  it("is null for anything else, so a malformed row is skipped rather than read as zero", () => {
    expect(parseCpuTime("")).toBeNull();
    expect(parseCpuTime("12")).toBeNull();
    expect(parseCpuTime("1:xx.00")).toBeNull();
  });
});

describe("parsePsAgentId", () => {
  it("takes the id from the environment, which follows the arguments", () => {
    expect(parsePsAgentId("node PATH=/bin PASEO_AGENT_ID=abc HOME=/root")).toBe("abc");
    expect(parsePsAgentId("node PASEO_AGENT_ID=abc")).toBe("abc");
  });

  it("prefers the environment over arguments that only mention it", () => {
    expect(parsePsAgentId("sh -c PASEO_AGENT_ID=decoy PATH=/bin PASEO_AGENT_ID=real")).toBe("real");
  });

  it("ignores a variable that merely ends in the name, and an empty value", () => {
    expect(parsePsAgentId("node NOT_PASEO_AGENT_ID=x")).toBeNull();
    expect(parsePsAgentId("node PASEO_AGENT_ID= PATH=/bin")).toBeNull();
    expect(parsePsAgentId("node PATH=/bin")).toBeNull();
  });
});

describe("parsePs", () => {
  const procs = parsePs(PS_STATS, PS_ENV);
  const byPid = (pid: number) => procs.find((proc) => proc.pid === pid);

  it("reads every row and skips what is not a process", () => {
    expect(procs.map((proc) => proc.pid)).toEqual([1, 1560, 1561, 1563, 1570]);
  });

  it("reads the columns, with memory in bytes and CPU in ticks", () => {
    expect(byPid(1560)).toEqual({
      key: "1560:Tue Oct 13 06:01:17 2026",
      pid: 1560,
      ppid: 1,
      ticks: 142,
      rss: 49264 * 1024,
      comm: "node",
      agentId: "agent-a",
    });
  });

  it("keeps a command path with spaces whole, and a space padded day in the start time", () => {
    expect(byPid(1561)).toMatchObject({
      key: "1561:Tue Oct 3 06:01:17 2026",
      comm: "Electron",
      agentId: "agent-b",
      ticks: (3600 + 120 + 3.45) * 100,
    });
  });

  it("tags only processes whose environment was readable", () => {
    expect(byPid(1)?.agentId).toBeNull();
    expect(byPid(1563)?.agentId).toBeNull();
  });

  it("cannot tell an argument from an environment when the environment was unreadable", () => {
    // Known limit: `ps` prints both in one column, so a process of another user whose arguments
    // spell out the variable looks tagged. When a real environment follows, the real one wins.
    expect(byPid(1570)?.agentId).toBe("agent-decoy");
  });

  it("keeps the same process under the same key from one scan to the next", () => {
    expect(parsePs(PS_STATS, "")[1]?.key).toBe(byPid(1560)?.key);
  });
});

describe("parseWindows", () => {
  const procs = parseWindows(WINDOWS_ROWS);
  const byPid = (pid: number) => procs.find((proc) => proc.pid === pid);

  it("leaves out the idle process, whose summed idle time would read as load", () => {
    expect(byPid(0)).toBeUndefined();
    expect(procs).toHaveLength(5);
  });

  it("converts 100 ns CPU time to ticks and keeps the working set as memory", () => {
    expect(byPid(2472)).toEqual({
      key: `2472:${STARTED}`,
      pid: 2472,
      ppid: 6200,
      ticks: 157,
      rss: 34095104,
      comm: "node",
      agentId: "agent-a",
    });
  });

  it("drops the .exe suffix in any case, and keeps names with spaces", () => {
    expect(byPid(6216)?.comm).toBe("Node");
    expect(byPid(8000)?.comm).toBe("Code Helper (Renderer)");
  });

  it("reads an empty agent column as no agent", () => {
    expect(byPid(4)?.agentId).toBeNull();
  });

  it("forgets a parent that started after its child, since the pid was reused", () => {
    expect(byPid(6216)?.ppid).toBe(0);
    // A parent that is older than its child stays.
    expect(byPid(7000)?.ppid).toBe(6216);
    // A parent that has exited is simply not found when charging.
    expect(byPid(2472)?.ppid).toBe(6200);
  });

  it("skips lines that are not rows, including the empty output of a failed run", () => {
    expect(parseWindows("")).toEqual([]);
    expect(parseWindows("Get-CimInstance : Access denied\n")).toEqual([]);
    expect(parseWindows("1\t2\tnot-a-time\t4\t5\t\tname")).toEqual([]);
  });

  it("charges the descendants of a tagged process to it", () => {
    const tree = parseWindows(
      [
        ["10", "1", "100", "0", "10", "agent-a", "claude.exe"],
        ["11", "10", "200", "0", "20", "", "cmd.exe"],
        ["12", "11", "300", "0", "30", "", "node.exe"],
      ]
        .map((row) => row.join("\t"))
        .join("\n"),
    );
    const { sessions } = attribute(tree, null, 0);
    expect(sessions).toMatchObject([{ agentId: "agent-a", rss: 60, processes: 3 }]);
  });
});

describe("the platform readers", () => {
  it("run ps twice with the flags the parser expects", async () => {
    const calls: string[][] = [];
    const procs = await readPsProcs(async (file, args) => {
      calls.push([file, ...args]);
      return args.includes("-E") ? PS_ENV : PS_STATS;
    });
    expect(calls).toEqual([
      ["/bin/ps", "-axww", "-o", "pid=,ppid=,lstart=,cputime=,rss=,comm="],
      ["/bin/ps", "-axww", "-E", "-o", "pid=,command="],
    ]);
    expect(procs.find((proc) => proc.pid === 1560)?.agentId).toBe("agent-a");
  });

  it("run the Windows script as one encoded PowerShell command", async () => {
    let seen: string[] = [];
    const procs = await readWindowsProcs(async (_file, args) => {
      seen = args;
      return WINDOWS_ROWS;
    });
    expect(seen.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(seen[3] ?? "", "base64").toString("utf16le")).toBe(WINDOWS_SCRIPT);
    expect(procs.find((proc) => proc.pid === 2472)?.agentId).toBe("agent-a");
  });

  it("let a failed run reject, so it is never mistaken for a host with nothing running", async () => {
    const broken = async () => {
      throw new Error("spawn ENOENT");
    };
    await expect(readPsProcs(broken)).rejects.toThrow("ENOENT");
    await expect(readWindowsProcs(broken)).rejects.toThrow("ENOENT");
  });
});

/**
 * The real thing on whichever OS this runs on: a tagged process that is busy, and under it a
 * grandchild whose environment was scrubbed, as many tools do. This is what CI runs on macOS and
 * Windows runners.
 */
describe("a live process tree", () => {
  const agentId = `top-test-${randomUUID()}`;
  const spawned: ChildProcess[] = [];
  const seenPids = new Set<number>();

  afterAll(() => {
    for (const child of spawned) child.kill();
    for (const pid of seenPids) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
  });

  const GRANDCHILD = "setTimeout(() => {}, 120000)";
  const CHILD = `
    const { spawn } = require("node:child_process");
    const env = { ...process.env };
    delete env.PASEO_AGENT_ID;
    spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}], { env, stdio: "ignore" });
    const end = Date.now() + 120000;
    while (Date.now() < end);
  `;

  interface Tree {
    root: ProcInfo;
    grand: ProcInfo;
  }

  // Real waits: this exercises the platform's own process table and clock, which fake timers
  // cannot stand in for.
  async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = await read();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it("attributes the busy process and its scrubbed child to the agent", {
    timeout: 90_000,
  }, async () => {
    const child = spawn(process.execPath, ["-e", CHILD], {
      env: { ...process.env, PASEO_AGENT_ID: agentId },
      stdio: "ignore",
    });
    spawned.push(child);
    const scan = defaultScan();
    const list = async () => (await scan()) ?? undefined;

    const find = (procs: ProcInfo[]): Tree | undefined => {
      const root = procs.find((proc) => proc.pid === child.pid);
      const grand = procs.find((proc) => proc.ppid === child.pid && proc.pid !== child.pid);
      for (const proc of [root, grand]) if (proc) seenPids.add(proc.pid);
      return root && grand ? { root, grand } : undefined;
    };
    const found = await until(async () => {
      const procs = await list();
      const tree = procs && find(procs);
      return procs && tree ? { procs, tree } : undefined;
    }, "the process tree to be listed");
    const firstAt = Date.now();
    const first = found.procs;
    const { root, grand } = found.tree;

    // The listing can say who owns what.
    expect(root.agentId).toBe(agentId);
    expect(grand.agentId).toBeNull();
    expect(root.comm.toLowerCase()).toContain("node");
    expect(root.rss).toBeGreaterThan(1024 * 1024);

    // And the busy loop shows up as CPU on the second scan, charged through the grandchild too.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const second = await until(list, "a second scan");
    const elapsed = (Date.now() - firstAt) / 1000;
    const { sessions } = attribute(second, attribute(first, null, 0).ticks, elapsed);
    const session = sessions.find((s) => s.agentId === agentId);
    expect(session?.processes).toBeGreaterThanOrEqual(2);
    expect(session?.cores).toBeGreaterThan(0.3);
    expect(session?.rss).toBeGreaterThanOrEqual(root.rss + grand.rss);
  });
});
