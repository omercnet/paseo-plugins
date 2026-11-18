import { describe, expect, it, vi } from "vitest";
import {
  type AgentAccess,
  accessFromState,
  agentAccessSchema,
  agentGetsBrowser,
  agentGetsBrowserByLabel,
  DEFAULT_AGENT_ACCESS,
  isAbsoluteDirectory,
  labelMatches,
  normalizeDirectory,
  parseEntries,
  type WorkspaceRef,
  workspacesForDirectory,
} from "../shared/agent-access";

const WORKSPACES: WorkspaceRef[] = [
  { id: "ws_a", projectId: "proj_1", workspaceDirectory: "/repos/one" },
  { id: "ws_b", projectId: "proj_1", workspaceDirectory: "/repos/one/packages/b" },
  { id: "ws_c", projectId: "proj_2", workspaceDirectory: "/repos/two/" },
  { id: "ws_d", projectId: "proj_3" },
  { id: "ws_e", projectId: "proj_4", workspaceDirectory: "/repos/shared" },
  { id: "ws_f", projectId: "proj_5", workspaceDirectory: "/repos/shared" },
];
const listWorkspaces = async () => WORKSPACES;
const listed = (over: Partial<AgentAccess>): AgentAccess => ({
  mode: "listed",
  providers: [],
  workspaces: [],
  projects: [],
  labels: [],
  ...over,
});

describe("who gets the browser tool", () => {
  const cases: [string, AgentAccess, { provider: string; cwd: string }, boolean][] = [
    ["all: any agent", DEFAULT_AGENT_ACCESS, { provider: "p", cwd: "/x" }, true],
    [
      "all ignores the lists",
      { ...DEFAULT_AGENT_ACCESS, providers: ["q"] },
      { provider: "p", cwd: "/x" },
      true,
    ],
    ["listed and empty: no agent", listed({}), { provider: "p", cwd: "/repos/one" }, false],
    ["provider listed", listed({ providers: ["p"] }), { provider: "p", cwd: "/x" }, true],
    ["provider not listed", listed({ providers: ["q"] }), { provider: "p", cwd: "/x" }, false],
    [
      "provider is an exact match",
      listed({ providers: ["pp"] }),
      { provider: "p", cwd: "/x" },
      false,
    ],
    [
      "workspace listed, same directory",
      listed({ workspaces: ["ws_a"] }),
      { provider: "p", cwd: "/repos/one" },
      true,
    ],
    [
      "workspace listed, directory inside it",
      listed({ workspaces: ["ws_a"] }),
      { provider: "p", cwd: "/repos/one/src" },
      true,
    ],
    [
      "the deepest workspace wins",
      listed({ workspaces: ["ws_a"] }),
      { provider: "p", cwd: "/repos/one/packages/b/src" },
      false,
    ],
    [
      "the deepest workspace is the match",
      listed({ workspaces: ["ws_b"] }),
      { provider: "p", cwd: "/repos/one/packages/b/src" },
      true,
    ],
    [
      "a sibling directory is not inside",
      listed({ workspaces: ["ws_a"] }),
      { provider: "p", cwd: "/repos/one-other" },
      false,
    ],
    [
      "trailing slashes are ignored",
      listed({ workspaces: ["ws_c"] }),
      { provider: "p", cwd: "/repos/two" },
      true,
    ],
    [
      "project listed",
      listed({ projects: ["proj_1"] }),
      { provider: "p", cwd: "/repos/one/packages/b" },
      true,
    ],
    [
      "project not listed",
      listed({ projects: ["proj_2"] }),
      { provider: "p", cwd: "/repos/one" },
      false,
    ],
    [
      "no workspace contains the directory",
      listed({ workspaces: ["ws_a"], projects: ["proj_1"] }),
      { provider: "p", cwd: "/elsewhere" },
      false,
    ],
    [
      "a workspace without a directory never matches",
      listed({ workspaces: ["ws_d"] }),
      { provider: "p", cwd: "/repos/one" },
      false,
    ],
    [
      "any of the three lists is enough",
      listed({ providers: ["q"], projects: ["proj_2"] }),
      { provider: "p", cwd: "/repos/two/x" },
      true,
    ],
  ];
  it.each(cases)("%s", async (_name, access, agent, expected) => {
    await expect(agentGetsBrowser(access, agent, listWorkspaces)).resolves.toBe(expected);
  });

  it("does not look up workspaces when the mode is all, the lists are empty, or the provider matched", async () => {
    const lookup = vi.fn(listWorkspaces);
    await agentGetsBrowser(DEFAULT_AGENT_ACCESS, { provider: "p", cwd: "/repos/one" }, lookup);
    await agentGetsBrowser(listed({}), { provider: "p", cwd: "/repos/one" }, lookup);
    await agentGetsBrowser(
      listed({ providers: ["p"], workspaces: ["ws_a"] }),
      { provider: "p", cwd: "/repos/one" },
      lookup,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a failed workspace lookup matches nothing, but a listed provider still matches", async () => {
    const failing = async () => {
      throw new Error("daemon unavailable");
    };
    const agent = { provider: "p", cwd: "/repos/one" };
    await expect(agentGetsBrowser(listed({ workspaces: ["ws_a"] }), agent, failing)).resolves.toBe(
      false,
    );
    await expect(
      agentGetsBrowser(listed({ providers: ["p"], workspaces: ["ws_a"] }), agent, failing),
    ).resolves.toBe(true);
  });
});

describe("workspacesForDirectory", () => {
  it("accepts Windows separators", () => {
    const windows = [{ id: "w", projectId: "p", workspaceDirectory: "C:\\repos\\one" }];
    expect(workspacesForDirectory("C:\\repos\\one\\src", windows).map((w) => w.id)).toEqual(["w"]);
  });

  it("returns every workspace at the deepest matching directory", () => {
    expect(workspacesForDirectory("/repos/shared/src", WORKSPACES).map((w) => w.id)).toEqual([
      "ws_e",
      "ws_f",
    ]);
    expect(workspacesForDirectory("/elsewhere", WORKSPACES)).toEqual([]);
  });
});

describe("the setting", () => {
  it("defaults to all, with empty lists", () => {
    expect(agentAccessSchema.parse({})).toEqual(DEFAULT_AGENT_ACCESS);
  });

  it("falls back to all when the setting cannot be read or is invalid", () => {
    for (const state of [undefined, { status: "invalid" }, { status: "loading" }]) {
      expect(accessFromState(state)).toEqual(DEFAULT_AGENT_ACCESS);
    }
    expect(accessFromState({ status: "invalid", values: listed({}) } as never)).toEqual(
      DEFAULT_AGENT_ACCESS,
    );
    expect(accessFromState({ status: "ready", values: listed({ providers: ["p"] }) })).toEqual(
      listed({ providers: ["p"] }),
    );
  });

  it("rejects an unknown mode and over-long or empty entries", () => {
    expect(agentAccessSchema.safeParse({ mode: "some" }).success).toBe(false);
    expect(agentAccessSchema.safeParse({ providers: [""] }).success).toBe(false);
    expect(agentAccessSchema.safeParse({ projects: ["x".repeat(257)] }).success).toBe(false);
    expect(agentAccessSchema.safeParse({ workspaces: Array(201).fill("w") }).success).toBe(false);
  });

  it("parses typed lists: commas or new lines, trimmed, without blanks or repeats", () => {
    expect(parseEntries("a, b\nc ,, a\n  \n")).toEqual({ entries: ["a", "b", "c"], error: null });
    expect(parseEntries("")).toEqual({ entries: [], error: null });
  });

  it("reports an entry over 256 characters or a list over 200 instead of dropping it", () => {
    expect(parseEntries(`ok, ${"x".repeat(257)}`).error).toMatch(/longer than 256/);
    expect(parseEntries("x".repeat(256)).error).toBeNull();
    const many = Array.from({ length: 201 }, (_, i) => `w${i}`).join(",");
    expect(parseEntries(many).error).toMatch(/200 entries/);
    expect(parseEntries(many.replace(",w200", "")).error).toBeNull();
  });
});

describe("normalizeDirectory", () => {
  it.each([
    ["/repos/one/../outside", "/repos/outside"],
    ["/repos/one/./src//deep/", "/repos/one/src/deep"],
    ["/repos/one/src/../../..", "/"],
    ["/../..", "/"],
    ["/", "/"],
    [".", ""],
    ["C:\\repos\\one\\..\\two", "C:/repos/two"],
    ["C:\\..\\repos\\one", "C:/repos/one"],
    ["C:\\", "C:/"],
    ["C:", "C:/"],
    ["c:/a//b/", "c:/a/b"],
    ["c:/../x", "c:/x"],
    ["C:repos", "C:repos"],
    ["../x", "../x"],
    ["a/../..", ".."],
  ])("%s", (input, expected) => {
    expect(normalizeDirectory(input)).toBe(expected);
  });
});

describe("a workspace at the filesystem root", () => {
  const root = [{ id: "r", projectId: "p", workspaceDirectory: "/" }];
  it("contains every absolute path, and no relative or empty one", () => {
    for (const cwd of ["/", "/repos/one", "/repos/../x", "/.."]) {
      expect(workspacesForDirectory(cwd, root).map((w) => w.id)).toEqual(["r"]);
    }
    for (const cwd of ["", ".", "repos/one", "../x"]) {
      expect(workspacesForDirectory(cwd, root)).toEqual([]);
    }
  });
});

describe("a Windows drive root", () => {
  const windows = [{ id: "w", projectId: "p", workspaceDirectory: "C:\\repos\\one" }];
  it("cannot be climbed above, and is not another drive", () => {
    expect(workspacesForDirectory("C:\\..\\repos\\one", windows).map((w) => w.id)).toEqual(["w"]);
    expect(workspacesForDirectory("C:\\repos\\one\\src", windows).map((w) => w.id)).toEqual(["w"]);
    expect(workspacesForDirectory("D:\\repos\\one", windows)).toEqual([]);
    expect(workspacesForDirectory("repos/one", windows)).toEqual([]);
  });
  it("a workspace at a drive root contains that drive only", () => {
    const drive = [{ id: "d", projectId: "p", workspaceDirectory: "C:\\" }];
    expect(workspacesForDirectory("C:\\repos", drive).map((w) => w.id)).toEqual(["d"]);
    expect(workspacesForDirectory("D:\\repos", drive)).toEqual([]);
  });
});

describe("dot segments cannot reach a workspace the agent is not in", () => {
  const one = [{ id: "w", projectId: "p", workspaceDirectory: "/repos/one" }];
  it("does not match a path that climbs out of the workspace", () => {
    expect(workspacesForDirectory("/repos/one/../outside", one)).toEqual([]);
    expect(workspacesForDirectory("/repos/one/src/../../two", one)).toEqual([]);
    expect(workspacesForDirectory("/repos/onex", one)).toEqual([]);
  });
  it("matches a path that is inside after resolving, and a workspace directory with dots", () => {
    expect(workspacesForDirectory("/repos/one/src/../lib", one).map((w) => w.id)).toEqual(["w"]);
    expect(workspacesForDirectory("/repos/one/x/..", one).map((w) => w.id)).toEqual(["w"]);
    const dotted = [{ id: "d", projectId: "p", workspaceDirectory: "/repos/./one/../two/" }];
    expect(workspacesForDirectory("/repos/two/src", dotted).map((w) => w.id)).toEqual(["d"]);
  });
  it("picks the deepest workspace by the resolved path", () => {
    const nested = [
      { id: "outer", projectId: "p", workspaceDirectory: "/repos" },
      { id: "inner", projectId: "p", workspaceDirectory: "/repos/one" },
    ];
    expect(workspacesForDirectory("/repos/x/../one/src", nested).map((w) => w.id)).toEqual([
      "inner",
    ]);
  });
});

describe("labels", () => {
  const labels = { team: "blue", empty: "", "a=b": "c", "": "bare", pair: "a=b" };
  it.each([
    [["team"], true],
    [["team=blue"], true],
    [["team=red"], false],
    [["team="], false],
    [["squad"], false],
    [["empty"], true],
    [["empty="], true],
    [["a=b"], false],
    [["a"], false],
    [["=blue"], false],
    [["=", ""], false],
    [["=bare"], false],
    [["pair=a=b"], true],
    [["pair=a"], false],
    [["Team"], false],
    [["team=Blue"], false],
    [["squad", "team=blue"], true],
    [[], false],
    [["toString"], false],
    [["constructor=x"], false],
  ])("%j matches %s", (entries, expected) => {
    expect(labelMatches(entries, labels)).toBe(expected);
  });

  it("gives the tool by label in listed mode only", () => {
    expect(agentGetsBrowserByLabel(listed({ labels: ["team"] }), labels)).toBe(true);
    expect(agentGetsBrowserByLabel({ ...listed({ labels: ["team"] }), mode: "all" }, labels)).toBe(
      false,
    );
    expect(agentGetsBrowserByLabel(listed({}), labels)).toBe(false);
  });

  it("is a list of the setting, empty by default, with the same limits as the others", () => {
    expect(agentAccessSchema.parse({}).labels).toEqual([]);
    expect(agentAccessSchema.safeParse({ labels: ["team=blue"] }).success).toBe(true);
    expect(agentAccessSchema.safeParse({ labels: [""] }).success).toBe(false);
    expect(agentAccessSchema.safeParse({ labels: ["x".repeat(257)] }).success).toBe(false);
    expect(agentAccessSchema.safeParse({ labels: Array(201).fill("l") }).success).toBe(false);
  });
});

describe("only absolute directories match a workspace", () => {
  it.each([
    ["/", true],
    ["/etc", true],
    ["C:/", true],
    ["c:/x", true],
    ["", false],
    [".", false],
    ["..", false],
    ["etc", false],
    ["C:x", false],
  ])("isAbsoluteDirectory(%j) is %s", (path, expected) => {
    expect(isAbsoluteDirectory(normalizeDirectory(path))).toBe(expected);
  });

  it("does not let a relative workspace directory contain an absolute agent directory", () => {
    const relative = [{ id: "r", projectId: "p", workspaceDirectory: "." }];
    expect(workspacesForDirectory("/etc", relative)).toEqual([]);
    expect(workspacesForDirectory("/", relative)).toEqual([]);
    const empty = [{ id: "e", projectId: "p", workspaceDirectory: "" }];
    expect(workspacesForDirectory("/etc", empty)).toEqual([]);
  });

  it("does not match a relative or empty agent directory, even against a root workspace", () => {
    const root = [{ id: "root", projectId: "p", workspaceDirectory: "/" }];
    for (const cwd of ["", ".", "etc", "../etc"])
      expect(workspacesForDirectory(cwd, root)).toEqual([]);
    expect(workspacesForDirectory("/etc", root).map((w) => w.id)).toEqual(["root"]);
  });
});
