import assert from "node:assert/strict";
import test from "node:test";

import { buildNpmReleaseMatrix } from "./build-npm-release-matrix.mjs";

const releaseConfig = {
  packages: {
    "agent-crew": { "package-name": "agent-crew" },
    "fresh-worktrees": { "package-name": "fresh-worktrees" },
    "paseo-shared-browser": { "package-name": "shared-browser" },
    "private-plugin": { "package-name": "private-plugin" },
  },
};

const packages = {
  "agent-crew": { name: "@omercnet/paseo-agent-crew" },
  "fresh-worktrees": { name: "@omercnet/paseo-fresh-worktrees" },
  "paseo-shared-browser": { name: "@omercnet/paseo-shared-browser" },
  "private-plugin": { name: "@omercnet/private-plugin", private: true },
};

function readPackage(directory) {
  return packages[directory];
}

test("discovers released public packages from Release Please configuration", () => {
  const matrix = buildNpmReleaseMatrix(
    {
      "agent-crew--release_created": "false",
      "fresh-worktrees--release_created": "true",
      "fresh-worktrees--tag_name": "fresh-worktrees-v1.1.2",
      "fresh-worktrees--sha": "a".repeat(40),
      "paseo-shared-browser--release_created": "true",
      "paseo-shared-browser--tag_name": "shared-browser-v0.3.2",
      "paseo-shared-browser--sha": "b".repeat(40),
      "private-plugin--release_created": "true",
      "private-plugin--tag_name": "private-plugin-v1.0.0",
      "private-plugin--sha": "c".repeat(40),
    },
    releaseConfig,
    readPackage,
  );

  assert.deepEqual(matrix, {
    include: [
      {
        directory: "fresh-worktrees",
        name: "@omercnet/paseo-fresh-worktrees",
        tag: "fresh-worktrees-v1.1.2",
        sha: "a".repeat(40),
      },
      {
        directory: "paseo-shared-browser",
        component: "shared-browser",
        name: "@omercnet/paseo-shared-browser",
        tag: "shared-browser-v0.3.2",
        sha: "b".repeat(40),
      },
    ],
  });
});

test("rejects incomplete metadata for a released package", () => {
  assert.throws(
    () =>
      buildNpmReleaseMatrix(
        {
          "fresh-worktrees--release_created": "true",
          "fresh-worktrees--tag_name": "fresh-worktrees-v1.1.2",
        },
        releaseConfig,
        readPackage,
      ),
    /omitted tag or SHA outputs for fresh-worktrees/,
  );
});
