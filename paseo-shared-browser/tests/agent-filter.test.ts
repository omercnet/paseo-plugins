import { describe, expect, it, vi } from "vitest";
import {
  type AgentAccess,
  accessFromState,
  agentAccessSchema,
  agentGetsBrowser,
  DEFAULT_AGENT_ACCESS,
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
    expect(parseEntries("a, b\nc ,, a\n  \n")).toEqual(["a", "b", "c"]);
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries("x".repeat(257))).toEqual([]);
  });
});
