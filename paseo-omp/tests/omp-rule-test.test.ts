import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { testOmpRulesWithDependencies } from "../server/omp-rule-test";
import type { OmpRulesDependencies } from "../server/omp-rules";
import { type BoundedRun, defaultSpawn, runBounded } from "../server/provider-diagnostics";
import { MAX_RULE_TEST_CHARS, testOmpRules } from "../shared/omp-rules";

const SCRATCH_PREFIX = join(tmpdir(), "paseo-omp-rules-");

function exited(stdout: string, exitCode = 0): BoundedRun {
  return {
    outcome: "exited",
    stdout,
    truncated: false,
    exitCode,
    signal: null,
    spawnErrorCode: null,
    cleanupFailed: false,
  };
}

/** The shape `omp ttsr test --json` printed on a real run (omp 18.13), trimmed to two rules. */
const REAL_OUTPUT = JSON.stringify({
  source: "text",
  snippetPreview: "hello CANARY_MOCK_OK world",
  snippetBytes: 27,
  evaluated: 26,
  triggered: [
    {
      name: "no-canary",
      path: "/home/me/.omp/agent/rules/no-canary.md",
      sourceProvider: "native",
      matched: { regex: ["CANARY_MOCK_OK"], ast: [] },
      defined: { regex: ["CANARY_MOCK_OK"], ast: [] },
    },
  ],
  notTriggered: [
    {
      name: "go-bench-loop",
      path: "builtin-defaults:go-bench-loop.md",
      sourceProvider: "builtin-defaults",
      matched: { regex: [], ast: [] },
      defined: { regex: [], ast: ["func $F() {}"] },
      skippedAst: "astCondition requires --source tool and a --path with a file extension",
    },
  ],
});

function fakeOmp(run: BoundedRun = exited(REAL_OUTPUT)) {
  const calls: { args: readonly string[]; cwd: string; input: string | undefined }[] = [];
  const dependencies: OmpRulesDependencies = {
    resolveExecutable: async () => "/usr/bin/omp",
    run: async (_executable, args, cwd, input) => {
      calls.push({ args, cwd, input });
      return run;
    },
    makeScratchDir: (prefix) => mkdtemp(prefix),
    // Only ever deletes a directory this suite's scratch prefix created.
    removeDir: async (path) => {
      if (path.startsWith(SCRATCH_PREFIX)) await rm(path, { recursive: true, force: true });
    },
  };
  return { calls, dependencies };
}

describe("testing a snippet against the rules", () => {
  test("lists the rules that fired, with what matched and where the rule lives", async () => {
    const fake = fakeOmp();
    const result = await testOmpRulesWithDependencies(
      { snippet: "hello CANARY_MOCK_OK world" },
      fake.dependencies,
    );
    expect(result).toEqual({
      status: "ready",
      evaluated: 26,
      triggered: [
        {
          name: "no-canary",
          provider: "native",
          path: "/home/me/.omp/agent/rules/no-canary.md",
          regex: ["CANARY_MOCK_OK"],
          ast: [],
        },
      ],
    });
  });

  test("sends the snippet over stdin, never in the arguments", async () => {
    const fake = fakeOmp();
    const snippet = "$(touch /tmp/pwned) ; --rule x";
    await testOmpRulesWithDependencies({ snippet }, fake.dependencies);
    const [call] = fake.calls;
    expect(call?.input).toBe(snippet);
    expect(call?.args).toEqual(["ttsr", "test", "--json", "--file", "-"]);
  });

  test("a path or source can only be a value of its own flag", async () => {
    const fake = fakeOmp();
    await testOmpRulesWithDependencies(
      { snippet: "x", path: "--rule=/etc/passwd", source: "tool" },
      fake.dependencies,
    );
    expect(fake.calls[0]?.args).toEqual([
      "ttsr",
      "test",
      "--json",
      "--file",
      "-",
      "--source=tool",
      "--path=--rule=/etc/passwd",
    ]);
  });

  test("a global test runs where no project's files can be found", async () => {
    const fake = fakeOmp();
    await testOmpRulesWithDependencies({ snippet: "x" }, fake.dependencies);
    expect(fake.calls[0]?.cwd.startsWith(SCRATCH_PREFIX)).toBe(true);
  });

  test("a workspace test runs in the workspace", async () => {
    const fake = fakeOmp();
    const workspace = await mkdtemp(join(tmpdir(), "omp-rule-test-"));
    try {
      await testOmpRulesWithDependencies({ snippet: "x", cwd: workspace }, fake.dependencies);
      expect(fake.calls[0]?.cwd).toBe(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("keeps readable hits and bounds the matched patterns", async () => {
    const fake = fakeOmp(
      exited(
        JSON.stringify({
          evaluated: 2,
          triggered: [
            "junk",
            { name: "", path: "x", sourceProvider: "native", matched: { regex: [], ast: [] } },
            {
              name: "wide",
              path: "/r/wide.md",
              sourceProvider: "native",
              matched: { regex: Array(50).fill("y".repeat(5_000)), ast: [] },
            },
          ],
        }),
      ),
    );
    const result = await testOmpRulesWithDependencies({ snippet: "x" }, fake.dependencies);
    if (result.status !== "ready") throw new Error("expected a result");
    expect(result.triggered.map((hit) => hit.name)).toEqual(["wide"]);
    expect(result.triggered[0]?.regex).toHaveLength(20);
    expect(result.triggered[0]?.regex[0]).toHaveLength(2_000);
  });

  test.each([
    ["a failing omp", exited("", 1)],
    ["output that is not JSON", exited("not json")],
    ["JSON of another shape", exited(JSON.stringify({ triggered: "no" }))],
    ["a timeout", { ...exited(""), outcome: "timeout", exitCode: null } satisfies BoundedRun],
  ])("%s is an error result, not a rejection", async (_label, run) => {
    const result = await testOmpRulesWithDependencies({ snippet: "x" }, fakeOmp(run).dependencies);
    expect(result.status).toBe("error");
  });

  test("reports a missing omp command", async () => {
    const fake = fakeOmp();
    const result = await testOmpRulesWithDependencies(
      { snippet: "x" },
      { ...fake.dependencies, resolveExecutable: async () => null },
    );
    expect(result).toEqual({
      status: "error",
      message: "The omp command was not found on this host",
    });
    expect(fake.calls).toEqual([]);
  });

  test("the contract bounds the snippet and the path", () => {
    const parse = (input: object) => testOmpRules.input.safeParse(input).success;
    expect(parse({ snippet: "x".repeat(MAX_RULE_TEST_CHARS) })).toBe(true);
    expect(parse({ snippet: "x".repeat(MAX_RULE_TEST_CHARS + 1) })).toBe(false);
    expect(parse({ snippet: "" })).toBe(false);
    expect(parse({ snippet: "x", path: "a\0b" })).toBe(false);
    expect(parse({ snippet: "x", source: "shell" })).toBe(false);
    expect(parse({ snippet: "x", extra: 1 })).toBe(false);
  });
});

describe("running a process with stdin", () => {
  test("a real child reads exactly the input, and sees end of input without one", async () => {
    const echo = ["-e", "process.stdin.pipe(process.stdout)"];
    const piped = await runBounded(
      defaultSpawn,
      process.execPath,
      echo,
      process.env,
      10_000,
      500,
      1_000,
      undefined,
      0,
      "héllo\nworld",
    );
    expect(piped).toMatchObject({ outcome: "exited", exitCode: 0, stdout: "héllo\nworld" });
    const ignored = await runBounded(
      defaultSpawn,
      process.execPath,
      echo,
      process.env,
      10_000,
      500,
      1_000,
    );
    expect(ignored).toMatchObject({ outcome: "exited", exitCode: 0, stdout: "" });
  });
});
