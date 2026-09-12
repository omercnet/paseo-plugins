import { describe, expect, test, vi } from "vitest";
import { handleGetWorkspaceBead, handleGetWorkspaceBeads } from "../server/beads";
import { BeadsSnapshotSchema, getWorkspaceBead } from "../shared/beads";

type WorkspaceContext = Parameters<typeof handleGetWorkspaceBeads>[1];
type CommandRunner = NonNullable<Parameters<typeof handleGetWorkspaceBeads>[2]>;
type CommandCall = {
  command: string;
  args: string[];
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
  };
};

function workspaceContext(
  workspaceDirectory: string,
  requestedWorkspaceIds: string[] = [],
): WorkspaceContext {
  return {
    paseo: {
      workspaces: {
        ref(workspaceId: string) {
          requestedWorkspaceIds.push(workspaceId);
          return {
            refresh: async () => ({ workspaceDirectory }),
          };
        },
      },
    },
  } as unknown as WorkspaceContext;
}

function recordingRunner(respond: (call: CommandCall) => unknown | Promise<unknown>): {
  calls: CommandCall[];
  runner: CommandRunner;
} {
  const calls: CommandCall[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    const call = {
      command,
      args: [...args],
      options: { ...options },
    };
    calls.push(call);
    const response = await respond(call);
    return { stdout: JSON.stringify(response) };
  };
  return { calls, runner };
}

function rawIssue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Issue ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: null,
    labels: [],
    parent: null,
    updated_at: "2026-09-01T12:00:00.000Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...overrides,
  };
}

function rawDependency(overrides: Record<string, unknown> = {}) {
  return {
    id: "dependency-1",
    title: "Dependency",
    status: "open",
    issue_type: "task",
    dependency_type: "blocks",
    ...overrides,
  };
}

function commandError(message: string, properties: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), properties);
}

function commandArgs(call: CommandCall): string[] {
  return call.args.slice(3);
}

describe("Beads RPC contract", () => {
  test("rejects issue IDs that could be parsed as CLI options", () => {
    expect(
      getWorkspaceBead.input.safeParse({ workspaceId: "workspace-1", issueId: "-profile" }).success,
    ).toBe(false);
    expect(
      getWorkspaceBead.input.safeParse({ workspaceId: "workspace-1", issueId: "issue-1" }).success,
    ).toBe(true);
  });
});

describe("workspace Beads snapshot", () => {
  test("uses the refreshed workspace directory and one global ready query for an empty list", async () => {
    const requestedWorkspaceIds: string[] = [];
    const { calls, runner } = recordingRunner(() => []);
    const input = {
      workspaceId: "workspace-1",
      workspaceDirectory: "/client-controlled/path",
    } as Parameters<typeof handleGetWorkspaceBeads>[0];

    const result = await handleGetWorkspaceBeads(
      input,
      workspaceContext("/authoritative/workspace", requestedWorkspaceIds),
      runner,
    );

    expect(requestedWorkspaceIds).toEqual(["workspace-1"]);
    expect(result).toMatchObject({ state: "ready", issues: [], truncated: false, message: null });
    expect(calls).toEqual([
      {
        command: "bd",
        args: [
          "--readonly",
          "-C",
          "/authoritative/workspace",
          "list",
          "--json",
          "--sort",
          "priority",
          "--limit",
          "501",
        ],
        options: {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      },
      {
        command: "bd",
        args: [
          "--readonly",
          "-C",
          "/authoritative/workspace",
          "list",
          "--ready",
          "--json",
          "--limit",
          "0",
        ],
        options: {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      },
    ]);
  });

  test("unwraps JSON envelopes and leaves objects without data on the raw-payload path", async () => {
    const issue = rawIssue("issue-1");
    const { runner: envelopeRunner } = recordingRunner(() => ({
      schema_version: 4,
      data: [issue],
    }));

    const snapshot = await handleGetWorkspaceBeads(
      { workspaceId: "workspace-1" },
      workspaceContext("/workspace"),
      envelopeRunner,
    );

    expect(snapshot).toMatchObject({
      state: "ready",
      issues: [{ id: "issue-1", isReady: true, isBlocked: false }],
    });

    const { runner: rawRunner } = recordingRunner(() => ({
      schema_version: 4,
      issues: [issue],
    }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        handleGetWorkspaceBeads(
          { workspaceId: "workspace-1" },
          workspaceContext("/workspace"),
          rawRunner,
        ),
      ).rejects.toThrow("Unable to load Beads issues. Check Paseo plugin logs for details.");
    } finally {
      errorLog.mockRestore();
    }
  });

  test("truncates 501 issues and uses one global ready query", async () => {
    const listed = Array.from({ length: 501 }, (_, index) => rawIssue(`issue-${index + 1}`));
    const { calls, runner } = recordingRunner((call) =>
      commandArgs(call).includes("--ready") ? [{ id: "issue-1" }] : listed,
    );

    const result = await handleGetWorkspaceBeads(
      { workspaceId: "workspace-1" },
      workspaceContext("/workspace"),
      runner,
    );

    expect(result.truncated).toBe(true);
    expect(result.issues).toHaveLength(500);
    expect(result.issues.at(-1)?.id).toBe("issue-500");
    expect(result.issues.slice(0, 2)).toMatchObject([
      { id: "issue-1", isReady: true, isBlocked: false },
      { id: "issue-2", isReady: false, isBlocked: true },
    ]);
    expect(calls.filter((call) => commandArgs(call).includes("--ready")).map(commandArgs)).toEqual([
      ["list", "--ready", "--json", "--limit", "0"],
    ]);
  });

  test("rejects oversized issue lists, summary fields, and global ready results", async () => {
    const overlongTimestamp = `2026-09-01T12:00:00.${"0".repeat(44)}Z`;
    expect(overlongTimestamp).toHaveLength(65);
    const cases: Array<[string, unknown]> = [
      ["issue list", Array.from({ length: 502 }, (_, index) => rawIssue(`issue-${index}`))],
      ["id", [rawIssue("i".repeat(257))]],
      ["title", [rawIssue("issue-1", { title: "t".repeat(4_097) })]],
      ["status", [rawIssue("issue-1", { status: "s".repeat(129) })]],
      ["issue type", [rawIssue("issue-1", { issue_type: "t".repeat(129) })]],
      ["assignee", [rawIssue("issue-1", { assignee: "a".repeat(513) })]],
      ["label", [rawIssue("issue-1", { labels: ["l".repeat(257)] })]],
      ["labels", [rawIssue("issue-1", { labels: Array.from({ length: 129 }, () => "label") })]],
      ["parent", [rawIssue("issue-1", { parent: "p".repeat(257) })]],
      ["timestamp", [rawIssue("issue-1", { updated_at: overlongTimestamp })]],
    ];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      for (const [, payload] of cases) {
        const { runner } = recordingRunner((call) =>
          commandArgs(call).includes("--ready") ? [] : payload,
        );
        await expect(
          handleGetWorkspaceBeads(
            { workspaceId: "workspace-1" },
            workspaceContext("/workspace"),
            runner,
          ),
        ).rejects.toThrow("Unable to load Beads issues. Check Paseo plugin logs for details.");
      }

      const { runner: readyRunner } = recordingRunner((call) =>
        commandArgs(call).includes("--ready")
          ? Array.from({ length: 25_001 }, (_, index) => ({ id: `ready-${index}` }))
          : [rawIssue("issue-1")],
      );
      await expect(
        handleGetWorkspaceBeads(
          { workspaceId: "workspace-1" },
          workspaceContext("/workspace"),
          readyRunner,
        ),
      ).rejects.toThrow("Unable to load Beads issues. Check Paseo plugin logs for details.");
    } finally {
      errorLog.mockRestore();
    }
  });

  test("bounds public snapshot messages", () => {
    expect(
      BeadsSnapshotSchema.safeParse({
        state: "not_initialized",
        issues: [],
        truncated: false,
        refreshedAt: "2026-09-01T12:00:00.000Z",
        message: "m".repeat(513),
      }).success,
    ).toBe(false);
  });

  test("logs bounded diagnostics but returns a stable generic unexpected error", async () => {
    const fakeDaemonPath = "/tmp/fake-beads-daemon.sock";
    const privateTail = "PRIVATE_STDERR_TAIL";
    const diagnostic = `Failed to connect to ${fakeDaemonPath}: ${"x".repeat(1_000)} ${privateTail}`;
    const { runner } = recordingRunner(() => {
      throw commandError("command failed", { stderr: diagnostic });
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        handleGetWorkspaceBeads(
          { workspaceId: "workspace-1" },
          workspaceContext("/workspace"),
          runner,
        ),
      ).rejects.toThrow("Unable to load Beads issues. Check Paseo plugin logs for details.");

      expect(errorLog).toHaveBeenCalledTimes(1);
      const logged = String(errorLog.mock.calls[0]?.[0]);
      expect(
        logged.startsWith("[paseo-beads] Unable to load Beads issues: Failed to connect to "),
      ).toBe(true);
      expect(logged).toContain(fakeDaemonPath);
      expect(logged).not.toContain(privateTail);
      expect(logged.length).toBeLessThanOrEqual(600);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("classifies an open issue excluded from the ready query as dependency-blocked", async () => {
    const { runner } = recordingRunner((call) =>
      commandArgs(call).includes("--ready")
        ? [{ id: "ready" }]
        : [rawIssue("blocked"), rawIssue("ready")],
    );

    const result = await handleGetWorkspaceBeads(
      { workspaceId: "workspace-1" },
      workspaceContext("/workspace"),
      runner,
    );

    expect(result.issues.map(({ id, isReady, isBlocked }) => ({ id, isReady, isBlocked }))).toEqual(
      [
        { id: "blocked", isReady: false, isBlocked: true },
        { id: "ready", isReady: true, isBlocked: false },
      ],
    );
  });

  test("reports the 10-second timeout when loading a workspace snapshot", async () => {
    const { runner } = recordingRunner(() => {
      throw commandError("Command timed out", { killed: true });
    });

    await expect(
      handleGetWorkspaceBeads(
        { workspaceId: "workspace-1" },
        workspaceContext("/workspace"),
        runner,
      ),
    ).rejects.toThrow("Unable to load Beads issues: Beads timed out after 10 seconds.");
  });

  test("reports a missing CLI without exposing a command failure", async () => {
    const { runner } = recordingRunner(() => {
      throw commandError("spawn bd ENOENT", { code: "ENOENT" });
    });
    const context = workspaceContext("/workspace");

    const snapshot = await handleGetWorkspaceBeads({ workspaceId: "workspace-1" }, context, runner);

    expect(snapshot).toMatchObject({
      state: "bd_unavailable",
      issues: [],
      truncated: false,
      message: "The bd CLI is not available on this Paseo host.",
    });
    await expect(
      handleGetWorkspaceBead({ workspaceId: "workspace-1", issueId: "issue-1" }, context, runner),
    ).rejects.toThrow("The bd CLI is not available on this Paseo host.");
  });

  test("reports an uninitialized workspace", async () => {
    const { runner } = recordingRunner(() => {
      throw commandError("command failed", { stderr: "No beads project found in /workspace" });
    });
    const context = workspaceContext("/workspace");

    const snapshot = await handleGetWorkspaceBeads({ workspaceId: "workspace-1" }, context, runner);

    expect(snapshot).toMatchObject({
      state: "not_initialized",
      issues: [],
      truncated: false,
      message: "Beads is not initialized for this workspace.",
    });
    await expect(
      handleGetWorkspaceBead({ workspaceId: "workspace-1", issueId: "issue-1" }, context, runner),
    ).rejects.toThrow("Beads is not initialized for this workspace.");
  });
});

describe("workspace Bead detail", () => {
  test("returns dependencies and dependents with readiness from the global ready query", async () => {
    const detail = rawIssue("issue-1", {
      description: "Description",
      acceptance_criteria: "Acceptance",
      design: "Design",
      notes: "Notes",
      dependency_count: null,
      dependent_count: null,
      dependencies: [
        {
          id: "dependency-1",
          title: "Dependency",
          status: "closed",
          issue_type: "task",
          dependency_type: "blocks",
        },
      ],
      dependents: [
        {
          id: "dependent-1",
          title: "Dependent",
          status: "open",
          issue_type: "bug",
          dependency_type: "blocks",
        },
      ],
    });
    const { calls, runner } = recordingRunner((call) =>
      commandArgs(call).includes("--ready") ? [] : [detail],
    );

    const result = await handleGetWorkspaceBead(
      { workspaceId: "workspace-1", issueId: "issue-1" },
      workspaceContext("/workspace"),
      runner,
    );

    expect(result.detail).toMatchObject({
      id: "issue-1",
      isReady: false,
      isBlocked: true,
      dependencyCount: 1,
      dependentCount: 1,
      dependencies: [
        {
          id: "dependency-1",
          title: "Dependency",
          status: "closed",
          issueType: "task",
          dependencyType: "blocks",
        },
      ],
      dependents: [
        {
          id: "dependent-1",
          title: "Dependent",
          status: "open",
          issueType: "bug",
          dependencyType: "blocks",
        },
      ],
    });
    expect(calls.map(commandArgs)).toEqual([
      ["show", "issue-1", "--json", "--include-dependents"],
      ["list", "--ready", "--json", "--limit", "0"],
    ]);
  });

  test("uses a positive global ready result for detail readiness", async () => {
    const { runner } = recordingRunner((call) =>
      commandArgs(call).includes("--ready") ? [{ id: "issue-1" }] : [rawIssue("issue-1")],
    );

    const result = await handleGetWorkspaceBead(
      { workspaceId: "workspace-1", issueId: "issue-1" },
      workspaceContext("/workspace"),
      runner,
    );

    expect(result.detail).toMatchObject({ isReady: true, isBlocked: false });
  });

  test("rejects oversized detail bodies, relationships, comments, and relationship fields", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["description", rawIssue("issue-1", { description: "d".repeat(262_145) })],
      ["acceptance criteria", rawIssue("issue-1", { acceptance_criteria: "a".repeat(262_145) })],
      ["design", rawIssue("issue-1", { design: "d".repeat(262_145) })],
      ["notes", rawIssue("issue-1", { notes: "n".repeat(262_145) })],
      [
        "dependencies",
        rawIssue("issue-1", {
          dependencies: Array.from({ length: 2_001 }, () => rawDependency()),
        }),
      ],
      [
        "dependents",
        rawIssue("issue-1", {
          dependents: Array.from({ length: 2_001 }, () => rawDependency()),
        }),
      ],
      ["comments", rawIssue("issue-1", { comments: Array.from({ length: 2_001 }, () => ({})) })],
      [
        "relationship id",
        rawIssue("issue-1", { dependencies: [rawDependency({ id: "i".repeat(257) })] }),
      ],
      [
        "relationship title",
        rawIssue("issue-1", { dependencies: [rawDependency({ title: "t".repeat(4_097) })] }),
      ],
      [
        "relationship status",
        rawIssue("issue-1", { dependencies: [rawDependency({ status: "s".repeat(129) })] }),
      ],
      [
        "relationship issue type",
        rawIssue("issue-1", { dependencies: [rawDependency({ issue_type: "t".repeat(129) })] }),
      ],
      [
        "relationship dependency type",
        rawIssue("issue-1", {
          dependencies: [rawDependency({ dependency_type: "t".repeat(129) })],
        }),
      ],
    ];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      for (const [, detail] of cases) {
        const { runner } = recordingRunner((call) =>
          commandArgs(call).includes("--ready") ? [] : [detail],
        );
        await expect(
          handleGetWorkspaceBead(
            { workspaceId: "workspace-1", issueId: "issue-1" },
            workspaceContext("/workspace"),
            runner,
          ),
        ).rejects.toThrow("Unable to load the Beads issue. Check Paseo plugin logs for details.");
      }
    } finally {
      errorLog.mockRestore();
    }
  });

  test("does not disclose stderr or daemon paths from unexpected detail failures", async () => {
    const fakeDaemonPath = "/tmp/private-beads-daemon.sock";
    const { runner } = recordingRunner(() => {
      throw commandError("command failed", {
        stderr: `Failed to connect to ${fakeDaemonPath}: private stderr`,
      });
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      let failure: unknown;
      try {
        await handleGetWorkspaceBead(
          { workspaceId: "workspace-1", issueId: "issue-1" },
          workspaceContext("/workspace"),
          runner,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "Unable to load the Beads issue. Check Paseo plugin logs for details.",
      );
      expect((failure as Error).message).not.toContain(fakeDaemonPath);
      expect((failure as Error).message).not.toContain("private stderr");
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  test("reports the 10-second timeout when loading issue detail", async () => {
    const { runner } = recordingRunner(() => {
      throw commandError("Command terminated", { signal: "SIGTERM" });
    });

    await expect(
      handleGetWorkspaceBead(
        { workspaceId: "workspace-1", issueId: "issue-1" },
        workspaceContext("/workspace"),
        runner,
      ),
    ).rejects.toThrow("Unable to load the Beads issue: Beads timed out after 10 seconds.");
  });

  test("returns null when the requested issue is missing", async () => {
    const { runner } = recordingRunner((call) => {
      if (commandArgs(call)[0] === "show") {
        throw commandError("command failed", {
          stderr: 'Error fetching missing: no issue found matching "missing"',
          stdout: JSON.stringify({
            error: "no issues found matching the provided IDs",
            schema_version: 1,
          }),
        });
      }
      return [];
    });

    const result = await handleGetWorkspaceBead(
      { workspaceId: "workspace-1", issueId: "missing" },
      workspaceContext("/workspace"),
      runner,
    );

    expect(result).toEqual({ detail: null });
  });
});
