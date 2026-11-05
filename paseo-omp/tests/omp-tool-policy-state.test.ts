import { describe, expect, test } from "vitest";
import {
  canAddBashRule,
  canAddToolRule,
  moveRule,
  policyWarnings,
  readBashRuleDraft,
  readBashRules,
  readFolders,
  readToolPolicies,
} from "../client/omp-tool-policy-state";

describe("tool policy state", () => {
  test("keeps only the stored entries OMP can honor", () => {
    expect(readToolPolicies({ bash: "allow", eval: "maybe", lsp: 3 })).toEqual({ bash: "allow" });
    expect(readToolPolicies(["bash"])).toEqual({});
    expect(
      readBashRules([
        { match: "ls*", approval: "allow" },
        { match: "rm*", approval: "block" },
        { approval: "deny" },
        "ls",
      ]),
    ).toEqual([{ match: "ls*", approval: "allow" }]);
    expect(readFolders(["~/a", 4, "~/b"])).toEqual(["~/a", "~/b"]);
  });

  test("drops stored entries Apply would reject so they cannot block every later save", () => {
    expect(readBashRules([{ match: "x".repeat(513), approval: "deny" }])).toEqual([]);
    expect(readBashRules([{ match: "ls\n", approval: "allow" }])).toEqual([]);
    expect(readToolPolicies({ "bad tool": "deny", bash: "deny" })).toEqual({ bash: "deny" });
    expect(readFolders(["~/a", "~/a", ""])).toEqual(["~/a"]);
  });

  test("moving a rule changes its position and stops at the ends", () => {
    expect(moveRule(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRule(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveRule(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveRule(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  test("warns when an allow rule overrides the approval mode and when asks hit subagents", () => {
    expect(policyWarnings({ policies: {}, rules: [] })).toEqual([]);
    expect(policyWarnings({ policies: { bash: "allow" }, rules: [] })).toHaveLength(1);
    expect(policyWarnings({ policies: { eval: "allow" }, rules: [] })).toEqual([]);
    expect(
      policyWarnings({
        policies: { eval: "prompt" },
        rules: [{ match: "ls*", approval: "allow" }],
      }),
    ).toHaveLength(2);
    expect(policyWarnings({ policies: { bash: "deny" }, rules: [] })).toEqual([]);
  });

  test("keeps a rule being edited on screen even while its pattern is empty", () => {
    const draft = [{ match: "", approval: "deny" }];
    expect(readBashRuleDraft(draft)).toEqual(draft);
    expect(readBashRules(draft)).toEqual([]);
    expect(readBashRuleDraft([{ match: "ls", approval: "block" }])).toEqual([]);
  });

  test("offers Add only for entries the whole list would accept", () => {
    expect(canAddToolRule({ eval: "deny" }, "eval")).toBe(false);
    expect(canAddToolRule({}, "bad tool")).toBe(false);
    const full = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`t${index}`, "deny"]),
    );
    expect(canAddToolRule(full as never, "one-more")).toBe(false);
    expect(canAddToolRule({ eval: "deny" }, "bash")).toBe(true);

    expect(canAddBashRule([], "")).toBe(false);
    expect(canAddBashRule([], "x".repeat(513))).toBe(false);
    expect(canAddBashRule([], "ls*")).toBe(true);
    const manyRules = Array.from({ length: 128 }, () => ({
      match: "ls",
      approval: "deny" as const,
    }));
    expect(canAddBashRule(manyRules, "one-more")).toBe(false);
  });
});
