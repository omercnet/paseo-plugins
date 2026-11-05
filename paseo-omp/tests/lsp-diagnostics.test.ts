import { describe, expect, test } from "vitest";
import {
  ompLspDiagnosticsSchema,
  parseOmpLspDiagnostics,
  transformOmpLspToolItem,
} from "../shared/lsp-diagnostics";

const SINGLE = `3 error(s):
# /repo/src/
## bad.ts
  1:7 [error] [ts] Type 'string' is not assignable to type 'number'. (2322)
  2:9 [warning] [ts] Cannot find name 'undefinedThing'. (2304)
  3:12 [info] [ts] Parameter 'x' implicitly has an 'any' type. (7006)`;

const GLOB = `\uf00c /repo/clean.ts: no issues
\uf00d /repo/bad2.ts: 1 error(s)
# /repo/
## bad2.ts
  1:14 [error] [ts] Type 'number' is not assignable to type 'string'. (2322)
\uf00d /repo/sub/deep/d.ts: 1 error(s)
# /repo/sub/deep/
## d.ts
  1:14 [hint] [ts] Unused. (6133)`;

function lspRow(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_call",
    callId: "call-1",
    name: "lsp",
    status: "completed",
    error: null,
    detail: {
      type: "unknown",
      input: { action: "diagnostics", file: "bad.ts" },
      output: {
        content: [{ type: "text", text: SINGLE }],
        details: { action: "diagnostics", serverName: "typescript-native", success: true },
      },
    },
    ...overrides,
  };
}

describe("OMP lsp diagnostics", () => {
  test("groups a single-target result by file with severities", () => {
    expect(parseOmpLspDiagnostics(SINGLE)).toEqual({
      files: [
        {
          path: "/repo/src/bad.ts",
          diagnostics: [
            {
              line: 1,
              column: 7,
              severity: "error",
              message: "[ts] Type 'string' is not assignable to type 'number'. (2322)",
            },
            {
              line: 2,
              column: 9,
              severity: "warning",
              message: "[ts] Cannot find name 'undefinedThing'. (2304)",
            },
            {
              line: 3,
              column: 12,
              severity: "info",
              message: "[ts] Parameter 'x' implicitly has an 'any' type. (7006)",
            },
          ],
        },
      ],
    });
  });

  test("rebuilds nested paths and skips per-file summary lines in a glob result", () => {
    const parsed = parseOmpLspDiagnostics(GLOB);
    expect(parsed?.files.map((file) => file.path)).toEqual([
      "/repo/bad2.ts",
      "/repo/sub/deep/d.ts",
    ]);
    expect(parsed?.files[1]?.diagnostics[0]?.severity).toBe("hint");
  });

  test("joins nested directory headings into a path", () => {
    const parsed = parseOmpLspDiagnostics(
      "1 error(s):\n# src/\n## deep/\n### d.ts\n  1:1 [error] [ts] Bad. (1)\n## e.ts\n  2:2 [error] [ts] Worse. (2)",
    );
    expect(parsed?.files.map((file) => file.path)).toEqual(["src/deep/d.ts", "src/e.ts"]);
  });

  test("keeps a multi-line message together", () => {
    const parsed = parseOmpLspDiagnostics(
      "1 error(s):\n# a.ts\n  1:1 [error] [ts] Argument is wrong.\n    Expected 1, got 2.",
    );
    expect(parsed?.files[0]?.diagnostics[0]?.message).toBe(
      "[ts] Argument is wrong.\nExpected 1, got 2.",
    );
  });

  test.each([
    ["a clean result", "OK"],
    ["a reference list", "Found 1 reference(s):\n  /repo/a.ts:1:2\n    foo()"],
    [
      "workspace checker output",
      "Workspace diagnostics (TypeScript):\nsrc/a.ts(1,1): error TS2322",
    ],
    ["text before any file", "Language servers: typescript-native"],
    ["an empty result", ""],
  ])("returns nothing for %s", (_name, text) => {
    expect(parseOmpLspDiagnostics(text)).toBeUndefined();
  });

  test("replaces a completed lsp row with a card keyed by its call id", () => {
    const result = transformOmpLspToolItem(lspRow());
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({
      type: "plugin",
      kind: "omp-lsp-diagnostics",
      id: "call-1",
      version: 1,
    });
    expect(ompLspDiagnosticsSchema.safeParse(result?.items[0]?.data).success).toBe(true);
  });

  test("handles a result the provider reduced to plain text", () => {
    const row = lspRow({ detail: { type: "plain_text", label: "lsp", text: SINGLE } });
    expect(transformOmpLspToolItem(row)?.items[0]?.kind).toBe("omp-lsp-diagnostics");
  });

  test.each([
    ["another tool", lspRow({ name: "grep" })],
    ["a running call", lspRow({ status: "running" })],
    ["a failed call", lspRow({ status: "failed" })],
    [
      "an unparsable result",
      lspRow({
        detail: { type: "unknown", input: {}, output: { content: [{ type: "text", text: "OK" }] } },
      }),
    ],
    ["a raw string result", lspRow({ detail: { type: "unknown", input: {}, output: SINGLE } })],
    ["an unrelated row", { type: "assistant_message", text: SINGLE }],
  ])("keeps the original row for %s", (_name, row) => {
    expect(transformOmpLspToolItem(row)).toBeUndefined();
  });
});
