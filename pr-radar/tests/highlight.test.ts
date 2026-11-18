import { expect, test } from "vitest";
import { splitHighlight } from "../client/highlight";

test("returns the whole text unmatched for an empty or blank query", () => {
  expect(splitHighlight("Fix login", "")).toEqual([{ text: "Fix login", match: false }]);
  expect(splitHighlight("Fix login", "   ")).toEqual([{ text: "Fix login", match: false }]);
});

test("matches case-insensitively and keeps the original casing", () => {
  expect(splitHighlight("Fix LOGIN bug", "login")).toEqual([
    { text: "Fix ", match: false },
    { text: "LOGIN", match: true },
    { text: " bug", match: false },
  ]);
});

test("trims the query like matchesRow", () => {
  expect(splitHighlight("Fix login", "  fix ")).toEqual([
    { text: "Fix", match: true },
    { text: " login", match: false },
  ]);
});

test("highlights every occurrence", () => {
  expect(splitHighlight("abcabc", "b")).toEqual([
    { text: "a", match: false },
    { text: "b", match: true },
    { text: "ca", match: false },
    { text: "b", match: true },
    { text: "c", match: false },
  ]);
});

test("treats regex characters literally", () => {
  expect(splitHighlight("a.b a+b (x) [y]", ".")).toEqual([
    { text: "a", match: false },
    { text: ".", match: true },
    { text: "b a+b (x) [y]", match: false },
  ]);
  expect(splitHighlight("a+b", "a+b")).toEqual([{ text: "a+b", match: true }]);
  expect(splitHighlight("f(x) [y]", "(x) [")).toEqual([
    { text: "f", match: false },
    { text: "(x) [", match: true },
    { text: "y]", match: false },
  ]);
});

test("returns unmatched text when nothing matches or the text is empty", () => {
  expect(splitHighlight("hello", "zzz")).toEqual([{ text: "hello", match: false }]);
  expect(splitHighlight("", "a")).toEqual([{ text: "", match: false }]);
});
