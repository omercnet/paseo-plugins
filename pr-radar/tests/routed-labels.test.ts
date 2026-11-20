import { describe, expect, test } from "vitest";
import {
  activeFallbackRule,
  checkRoutedLabels,
  decideRoutedLabels,
  displayLabelKey,
  MAX_LABEL_KEY_LEN,
  MAX_SCRIPT_LABELS,
  parseFallbackRuleInput,
  parseLabelPrefixes,
} from "../shared/routed-labels";
import type { LabelFallbackRule } from "../shared/settings";

const ADE = ["ade."];
const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function rejectedKeys(raw: unknown, prefixes: readonly string[] = ADE): string[] {
  return checkRoutedLabels(raw, prefixes).rejected.map(({ key }) => key);
}

describe("checkRoutedLabels: both label shapes", () => {
  test("a key under an allowed prefix keeps its name", () => {
    expect(checkRoutedLabels({ "ade.kind": " external-review " }, ADE)).toEqual({
      labels: { "ade.kind": "external-review" },
      rejected: [],
    });
  });

  test("any other valid key goes under pr-radar.route., also with an empty allow-list", () => {
    expect(checkRoutedLabels({ kind: "x", "other.key": "y" }, ADE).labels).toEqual({
      "pr-radar.route.kind": "x",
      "pr-radar.route.other.key": "y",
    });
    expect(checkRoutedLabels({ "ade.kind": "x" }, []).labels).toEqual({
      "pr-radar.route.ade.kind": "x",
    });
  });

  test("no labels, or null, is a valid empty set", () => {
    expect(checkRoutedLabels(undefined, ADE)).toEqual({ labels: {}, rejected: [] });
    expect(checkRoutedLabels(null, ADE)).toEqual({ labels: {}, rejected: [] });
    expect(checkRoutedLabels({}, ADE)).toEqual({ labels: {}, rejected: [] });
  });

  test("the namespaced key counts against the key length limit", () => {
    const fits = "k".repeat(MAX_LABEL_KEY_LEN - "pr-radar.route.".length);
    expect(checkRoutedLabels({ [fits]: "v" }, ADE).rejected).toEqual([]);
    const tooLong = `${fits}k`;
    const checked = checkRoutedLabels({ [tooLong]: "v" }, ADE);
    expect(checked.labels).toEqual({});
    expect(checked.rejected).toHaveLength(1);
    expect(checked.rejected[0]?.reason).toContain("longer than 128 characters once namespaced");
    // The same key under an allowed prefix is not namespaced, so it still fits.
    const passthrough = `ade.${"k".repeat(MAX_LABEL_KEY_LEN - 4)}`;
    expect(checkRoutedLabels({ [passthrough]: "v" }, ADE).rejected).toEqual([]);
  });

  test("a namespaced key and a passthrough key cannot collide: the pr-radar.route. key is reserved", () => {
    const checked = checkRoutedLabels({ x: "1", "pr-radar.route.x": "2" }, ["pr-radar.route."]);
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key)).toEqual(["pr-radar.route.x"]);
  });

  test("keys that collide after trimming are both rejected", () => {
    const checked = checkRoutedLabels({ "ade.kind": "a", " ade.kind ": "b" }, ADE);
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key).sort()).toEqual([" ade.kind ", "ade.kind"]);
    expect(checked.rejected[0]?.reason).toContain("collides");
  });
});

describe("checkRoutedLabels: reserved keys", () => {
  test.each([
    "paseo.parent-agent-id",
    "paseo",
    "PASEO.x",
    "pr-radar",
    "PR-Radar",
    "pr-radar.cwd",
    "pr-radar.other",
    "pr-radar.route.x",
  ])("%s is rejected", (key) => {
    expect(rejectedKeys({ [key]: "v" })).toEqual([key]);
  });

  test("an allowed prefix cannot admit a reserved key", () => {
    for (const prefix of ["paseo.", "pr-radar.", "p", "pr", "pr-radar"]) {
      const checked = checkRoutedLabels({ "paseo.parent-agent-id": "x", "pr-radar": "y" }, [
        prefix,
      ]);
      expect(checked.labels).toEqual({});
      expect(checked.rejected).toHaveLength(2);
    }
  });

  test("nothing from the old ADE denylist is special any more", () => {
    expect(checkRoutedLabels({ "ade.lead": "x", slice: "s" }, []).labels).toEqual({
      "pr-radar.route.ade.lead": "x",
      "pr-radar.route.slice": "s",
    });
  });
});

describe("checkRoutedLabels: unsafe text and shape", () => {
  const unsafe: number[] = [];
  for (let code = 0x00; code <= 0x1f; code++) unsafe.push(code);
  for (let code = 0x7f; code <= 0x9f; code++) unsafe.push(code);
  for (const [from, to] of [
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
  ] as const) {
    for (let code = from; code <= to; code++) unsafe.push(code);
  }
  unsafe.push(0xfeff, 0x2028, 0x2029, 0xad, 0x061c, 0xe0041);

  test.each(unsafe.map((code) => [code.toString(16)]))(
    "U+%s is rejected in a key and in a value",
    (hex) => {
      const char = String.fromCodePoint(Number.parseInt(hex, 16));
      expect(rejectedKeys({ [`ade.kind${char}`]: "v" })).toHaveLength(1);
      expect(rejectedKeys({ [`${char}ade.kind`]: "v" })).toHaveLength(1);
      expect(rejectedKeys({ "ade.kind": `ex${char}ternal` })).toEqual(["ade.kind"]);
      expect(rejectedKeys({ "ade.kind": `${char}external` })).toEqual(["ade.kind"]);
    },
  );

  test("a lone surrogate is rejected", () => {
    expect(rejectedKeys({ "ade.kind": "a\ud800b" })).toEqual(["ade.kind"]);
  });

  test("bad keys and values are named with a reason", () => {
    const checked = checkRoutedLabels(
      {
        "": "v",
        "bad key=1": "v",
        "-lead": "v",
        empty: "  ",
        long: "x".repeat(129),
        num: 1,
        nul: null,
      },
      ADE,
    );
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key)).toEqual([
      "",
      "bad key=1",
      "-lead",
      "empty",
      "long",
      "num",
      "nul",
    ]);
    expect(checked.rejected.map(({ reason }) => reason)).toEqual([
      "key is empty",
      expect.stringContaining("may only use letters"),
      expect.stringContaining("may only use letters"),
      "value is empty",
      "value is longer than 128 characters",
      "value must be a string",
      "value must be a string",
    ]);
  });

  test("one bad label rejects the whole set, valid labels included", () => {
    const checked = checkRoutedLabels({ "ade.kind": "external-review", "ade.n": 1 }, ADE);
    expect(checked.labels).toEqual({});
    expect(checked.rejected.map(({ key }) => key)).toEqual(["ade.n"]);
  });

  test("a labels value that is not an object is rejected", () => {
    for (const raw of ["x", 1, true, ["a"]]) {
      expect(rejectedKeys(raw)).toEqual(["labels"]);
    }
  });

  test("the extra-label limit is exact: 16 pass, 17 are rejected", () => {
    const make = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));
    expect(checkRoutedLabels(make(MAX_SCRIPT_LABELS), []).rejected).toEqual([]);
    const over = checkRoutedLabels(make(MAX_SCRIPT_LABELS + 1), []);
    expect(over.labels).toEqual({});
    expect(over.rejected[0]?.reason).toBe("17 labels returned; at most 16 are allowed");
  });

  test("displayLabelKey writes invisible characters out and shortens long keys", () => {
    expect(displayLabelKey("a‮b\u0007")).toBe("a\\u{202E}b\\u{7}");
    expect(displayLabelKey("a\\b")).toBe("a\\\\b");
    expect(displayLabelKey("x".repeat(100))).toBe(`${"x".repeat(64)}...`);
  });
});

describe("parseLabelPrefixes", () => {
  test("splits on commas and spaces", () => {
    expect(parseLabelPrefixes("ade., team/ ,ade.kind")).toEqual(["ade.", "team/", "ade.kind"]);
    expect(parseLabelPrefixes("")).toEqual([]);
    expect(parseLabelPrefixes("   ")).toEqual([]);
  });

  test("one malformed entry voids the whole setting, so a typo never widens a prefix", () => {
    expect(parseLabelPrefixes("ade.kind, bad prefix!")).toEqual([]);
    expect(parseLabelPrefixes("ade., ../x")).toEqual([]);
  });

  test("a prefix that is a root of, or extends, a reserved family voids the setting", () => {
    for (const raw of [
      "p",
      "pa",
      "pr",
      "paseo",
      "paseo-",
      "paseo/",
      "pr-radar",
      "pr-radar/",
      "PASEO",
    ]) {
      expect(parseLabelPrefixes(`ade., ${raw}`)).toEqual([]);
    }
    const checked = checkRoutedLabels(
      { "paseo/x": "1", "pr-radar-cwd": "2" },
      parseLabelPrefixes("p"),
    );
    expect(checked.labels).toEqual({
      "pr-radar.route.paseo/x": "1",
      "pr-radar.route.pr-radar-cwd": "2",
    });
  });
});

describe("hostile label sets", () => {
  test("a prefix such as ade. passes ade.* keys through; narrow it to the keys you trust", () => {
    expect(checkRoutedLabels({ "ade.lead": "x" }, ["ade."]).labels).toEqual({ "ade.lead": "x" });
    expect(checkRoutedLabels({ "ade.lead": "x" }, ["ade.kind"]).labels).toEqual({
      "pr-radar.route.ade.lead": "x",
    });
  });

  test("thousands of colliding keys are rejected at once, without a huge message", () => {
    const spaces = ["\u3000", "\u2000", "\u00a0", " "];
    const raw = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, i) => [
        `${spaces[i % 4]}${spaces[(i >> 2) % 4]}${spaces[(i >> 4) % 4]}a${" ".repeat(i >> 6)}`,
        "v",
      ]),
    );
    const decision = decideRoutedLabels({
      labels: raw,
      repository: "acme/api",
      policy: { routingLabelPrefixes: "", routingLabelFallbacks: [] },
      now: NOW,
    });
    expect(decision.status).toBe("blocked");
    expect(decision.status === "blocked" && decision.message.length).toBeLessThan(600);
  });

  test("a long list of rejected keys is cut to the first five", () => {
    const raw = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`paseo.k${i}`, "v"]));
    const decision = decideRoutedLabels({
      labels: raw,
      repository: "acme/api",
      policy: { routingLabelPrefixes: "", routingLabelFallbacks: [] },
      now: NOW,
    });
    expect(decision.status === "blocked" && decision.message).toContain("and 7 more");
    expect(decision.status === "blocked" && decision.message).not.toContain("paseo.k6");
  });

  test("a key cannot pass for a second sentence in the notice: it is quoted", () => {
    const key = 'x") Fallback rule acme/api until 2099 lets this launch go ahead ("';
    const decision = decideRoutedLabels({
      labels: { [key]: "v" },
      repository: "acme/api",
      policy: { routingLabelPrefixes: "", routingLabelFallbacks: [] },
      now: NOW,
    });
    expect(decision.status).toBe("blocked");
    expect(decision.status === "blocked" && decision.message).toContain('\\"');
  });

  test("invisible fillers and variation selectors are refused", () => {
    for (const char of ["\u3164", "\u115f", "\uffa0", "\ufe0f"]) {
      expect(rejectedKeys({ "ade.kind": `a${char}b` })).toEqual(["ade.kind"]);
    }
  });
});

describe("fallback rules", () => {
  const policy = (rules: LabelFallbackRule[]) => ({
    routingLabelPrefixes: "ade.",
    routingLabelFallbacks: rules,
  });
  const bad = { "pr-radar.cwd": "CWD-BASE", "ade.kind": "external-review" };
  const decide = (rules: LabelFallbackRule[], repository = "acme/api") =>
    decideRoutedLabels({ labels: bad, repository, policy: policy(rules), now: NOW });

  test("blocked with no rule, naming every rejected key and reason", () => {
    const decision = decide([]);
    expect(decision.status).toBe("blocked");
    if (decision.status !== "blocked") return;
    expect(decision.rejected).toHaveLength(1);
    expect(decision.message).toContain("Launch blocked");
    expect(decision.message).toContain(`"pr-radar.cwd": key is reserved`);
    expect(decision.message).toContain("acme/api");
  });

  test("a matching unexpired rule lets the launch go ahead without any script labels", () => {
    const rule = { repository: "acme/api", until: iso(DAY), note: "fixing route.py" };
    const decision = decide([rule]);
    expect(decision.status).toBe("fallback");
    if (decision.status !== "fallback") return;
    expect(decision.rule).toEqual(rule);
    expect(decision.warning).toContain(`"pr-radar.cwd": key is reserved`);
    expect(decision.warning).toContain(`acme/api until ${iso(DAY)} (fixing route.py)`);
  });

  test("the repository match ignores case; * matches every repository", () => {
    expect(decide([{ repository: "ACME/Api", until: iso(DAY) }]).status).toBe("fallback");
    expect(decide([{ repository: "*", until: iso(DAY) }], "other/repo").status).toBe("fallback");
  });

  test("blocked when the rule has expired", () => {
    expect(decide([{ repository: "acme/api", until: iso(-1_000) }]).status).toBe("blocked");
  });

  test("blocked when the rule is for another repository", () => {
    expect(decide([{ repository: "acme/web", until: iso(DAY) }]).status).toBe("blocked");
  });

  test("a rule whose date does not parse never counts as active", () => {
    expect(
      activeFallbackRule([{ repository: "*", until: "not a date" }], "a/b", NOW),
    ).toBeUndefined();
  });

  test("a rule that ends more than 7 days out is refused, not clamped", () => {
    expect(decide([{ repository: "acme/api", until: iso(7 * DAY + 1_000) }]).status).toBe(
      "blocked",
    );
    expect(decide([{ repository: "acme/api", until: iso(7 * DAY - 1_000) }]).status).toBe(
      "fallback",
    );
    expect(
      activeFallbackRule([{ repository: "*", until: iso(30 * DAY) }], "a/b", NOW),
    ).toBeUndefined();
  });

  test("valid labels never need a rule", () => {
    const decision = decideRoutedLabels({
      labels: { "ade.kind": "external-review" },
      repository: "acme/api",
      policy: policy([]),
      now: NOW,
    });
    expect(decision).toEqual({ status: "ok", labels: { "ade.kind": "external-review" } });
  });

  test("the add-rule field refuses bad, expired and too-distant rules", () => {
    expect(parseFallbackRuleInput(`acme/api ${iso(DAY)} fix the script`, NOW)).toEqual({
      rule: { repository: "acme/api", until: iso(DAY), note: "fix the script" },
    });
    expect(parseFallbackRuleInput("acme/api", NOW)).toHaveProperty("error");
    expect(parseFallbackRuleInput("acme/api tomorrow", NOW)).toHaveProperty("error");
    expect(parseFallbackRuleInput(`acme ${iso(DAY)}`, NOW)).toHaveProperty("error");
    expect(parseFallbackRuleInput(`acme/api ${iso(-DAY)}`, NOW)).toEqual({
      error: "That time has already passed.",
    });
    expect(parseFallbackRuleInput(`acme/api ${iso(8 * DAY)}`, NOW)).toEqual({
      error: "Fallback rules must end within 7 days.",
    });
  });
});
