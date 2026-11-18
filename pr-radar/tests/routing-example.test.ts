import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { RoutingScriptResultSchema } from "../shared/viewer-scope";

const SCRIPT = resolve(__dirname, "../examples/pr-radar-route.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function run(input: string) {
  return spawnSync("python3", [SCRIPT], { input, encoding: "utf8" });
}

describe.skipIf(!hasPython)("examples/pr-radar-route.py contract", () => {
  test("answers a PR payload with a valid RoutingScriptResult", () => {
    const payload = {
      pr: { reviewRequestedFromMe: true, authorKind: "human" },
      workspace: {},
      defaults: {},
    };
    const res = run(JSON.stringify(payload));
    expect(res.status).toBe(0);
    const parsed = RoutingScriptResultSchema.parse(JSON.parse(res.stdout));
    expect(parsed.thinkingOptionId).toBe("high");
    expect(parsed.reason).toBeTruthy();
  });

  test("bot PRs get light thinking and plain PRs no overrides", () => {
    const bot = run(JSON.stringify({ pr: { authorKind: "bot" } }));
    expect(RoutingScriptResultSchema.parse(JSON.parse(bot.stdout)).thinkingOptionId).toBe("low");
    const plain = run(JSON.stringify({ pr: { authorKind: "human" } }));
    expect(JSON.parse(plain.stdout)).toEqual({});
  });

  test("empty stdin is accepted, bad JSON fails with a stderr reason and no stdout", () => {
    expect(run("").status).toBe(0);
    const bad = run("not json");
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("not JSON");
    expect(bad.stdout).toBe("");
  });
});
