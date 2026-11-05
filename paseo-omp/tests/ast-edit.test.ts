import { describe, expect, test } from "vitest";
import { ompAstEditSchema, parseOmpAstEdit, transformOmpAstEditItem } from "../shared/ast-edit";

const PROPOSAL =
  "Staged as a proposal \u2014 files NOT modified yet. To apply: write a one-sentence reason to xd://resolve. To discard: write to xd://reject.";

const SINGLE = `${PROPOSAL}

[a.ts#387A]
-2:foo(1, 2)
+2:bar(2, 1)
-3:foo(3, 4)
+3:bar(4, 3)`;

const MULTI = `${PROPOSAL}

# a.ts#387A (2 replacements)
-2:foo(1, 2)
+2:bar(2, 1)
-3:foo(3, 4)
+3:bar(4, 3)

# sub/
## b.ts#D8CE (1 replacement)
-1:foo(5, 6)
+1:bar(6, 5)`;

function astEditRow(text: unknown, overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_call",
    callId: "call-ast",
    name: "ast_edit",
    status: "completed",
    error: null,
    detail: { type: "plain_text", label: "ast edit", text },
    ...overrides,
  };
}

describe("OMP ast_edit preview", () => {
  test("pairs removed and added lines for a single file", () => {
    expect(parseOmpAstEdit(SINGLE)).toEqual({
      files: [
        {
          path: "a.ts",
          changes: [
            { line: 2, before: "foo(1, 2)", after: "bar(2, 1)" },
            { line: 3, before: "foo(3, 4)", after: "bar(4, 3)" },
          ],
        },
      ],
    });
  });

  test("rebuilds directory paths for a multi-file preview", () => {
    const parsed = parseOmpAstEdit(MULTI);
    expect(parsed?.files.map((file) => file.path)).toEqual(["a.ts", "sub/b.ts"]);
    expect(parsed?.files[1]?.changes).toEqual([
      { line: 1, before: "foo(5, 6)", after: "bar(6, 5)" },
    ]);
  });

  test("shows a deleted node as an empty replacement", () => {
    const parsed = parseOmpAstEdit(`${PROPOSAL}\n\n[a.ts#387A]\n-2:debugger;\n+2:`);
    expect(parsed?.files[0]?.changes).toEqual([{ line: 2, before: "debugger;", after: "" }]);
  });

  test.each([
    ["no matches", "No replacements made"],
    ["plain line and column mode", `${PROPOSAL}\n\n[a.ts]\n-2:5 foo(1, 2)\n+2:5 bar(2, 1)`],
    ["a removed line without its replacement", `${PROPOSAL}\n\n[a.ts#387A]\n-2:foo(1, 2)`],
    ["mismatched line numbers", `${PROPOSAL}\n\n[a.ts#387A]\n-2:foo(1, 2)\n+3:bar(2, 1)`],
    ["a change before any file", `${PROPOSAL}\n\n-2:foo(1, 2)\n+2:bar(2, 1)`],
    ["a trailing limit notice", `${SINGLE}\nLimit reached; narrow paths.`],
    ["a trailing parse issue", `${SINGLE}\n\nParse issues:\n  a.py: could not parse`],
    ["an empty result", ""],
  ])("returns nothing for %s", (_name, text) => {
    expect(parseOmpAstEdit(text)).toBeUndefined();
  });

  test("replaces a completed ast_edit row with a card keyed by its call id", () => {
    const result = transformOmpAstEditItem(astEditRow(SINGLE));
    expect(result?.items[0]).toMatchObject({
      type: "plugin",
      kind: "omp-ast-edit",
      id: "call-ast",
      version: 1,
    });
    expect(ompAstEditSchema.safeParse(result?.items[0]?.data).success).toBe(true);
  });

  test.each([
    ["another tool", astEditRow(SINGLE, { name: "ast_grep" })],
    ["a running call", astEditRow(SINGLE, { status: "running" })],
    ["a row without text", astEditRow(undefined)],
    ["unparsable text", astEditRow("No replacements made")],
    [
      "an unmapped row",
      astEditRow(SINGLE, { detail: { type: "unknown", input: {}, output: SINGLE } }),
    ],
  ])("keeps the original row for %s", (_name, row) => {
    expect(transformOmpAstEditItem(row)).toBeUndefined();
  });
});
