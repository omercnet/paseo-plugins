import assert from "node:assert/strict";
import test from "node:test";

import { reportCompat } from "./report-compat.mjs";

function fakeGh(openIssues) {
  const calls = [];
  const gh = (...args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(openIssues);
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/o/r/issues/99\n";
    return "";
  };
  return { gh, calls };
}

const base = { repo: "o/r", label: "compat-omp-latest", title: "T", body: "B" };
const subcommands = (calls) =>
  calls.filter(([group]) => group === "issue").map(([, command]) => command);

test("opens one labelled issue when a lane starts failing", () => {
  const { gh, calls } = fakeGh([]);

  assert.deepEqual(reportCompat({ ...base, gh, state: "failing" }), {
    action: "created",
    url: "https://github.com/o/r/issues/99",
  });
  assert.deepEqual(subcommands(calls), ["list", "create"]);
  assert.deepEqual(calls[0], [
    "label",
    "create",
    "compat-omp-latest",
    "--repo",
    "o/r",
    "--color",
    "d4c5f9",
    "--description",
    "Automated upstream compatibility lane",
    "--force",
  ]);
  assert.ok(calls.at(-1).includes("--label"));
});

test("updates the existing issue instead of opening a second one", () => {
  const { gh, calls } = fakeGh([{ number: 333 }]);

  assert.deepEqual(reportCompat({ ...base, gh, state: "failing" }), {
    action: "updated",
    number: 333,
  });
  assert.deepEqual(subcommands(calls), ["list", "edit"]);
  const edit = calls.at(-1);
  assert.deepEqual(edit.slice(0, 3), ["issue", "edit", "333"]);
  assert.ok(edit.includes("--body"));
});

test("retitles and closes the issue when the lane goes green", () => {
  const { gh, calls } = fakeGh([{ number: 333 }]);

  assert.deepEqual(reportCompat({ ...base, gh, state: "passing" }), {
    action: "closed",
    number: 333,
  });
  assert.deepEqual(subcommands(calls), ["list", "edit", "close"]);
  // The closed record must not keep a stale "failing on X" title.
  assert.ok(calls.at(-2).includes("--title"));
  assert.ok(!calls.at(-2).includes("--body"));
});

test("does nothing when a green lane has no open issue", () => {
  const { gh, calls } = fakeGh([]);

  assert.deepEqual(reportCompat({ ...base, gh, state: "passing" }), { action: "noop" });
  assert.deepEqual(subcommands(calls), ["list"]);
});

test("rejects an unknown state and missing inputs before calling gh", () => {
  const { gh, calls } = fakeGh([]);

  assert.throws(() => reportCompat({ ...base, gh, state: "cancelled" }), /failing or passing/);
  assert.throws(() => reportCompat({ ...base, gh, label: "", state: "failing" }), /requires repo/);
  assert.throws(
    () => reportCompat({ ...base, gh, body: undefined, state: "failing" }),
    /requires repo/,
  );
  assert.deepEqual(calls, []);
});
