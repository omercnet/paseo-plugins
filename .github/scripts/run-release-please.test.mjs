import assert from "node:assert/strict";
import test from "node:test";

import {
  readOptions,
  runReleasePlease,
} from "./run-release-please.mjs";

function createHarness({ releases = [], pullRequests = [], releaseError, reloadError } = {}) {
  const events = [];
  let loads = 0;
  const outputs = [];
  return {
    events,
    outputs,
    loadManifest: async () => {
      loads += 1;
      events.push(`load-${loads}`);
      if (loads === 2 && reloadError) throw reloadError;
      return {
        buildReleases: async () => {
          events.push("build-releases");
          return releases;
        },
        buildPullRequests: async () => {
          events.push("build-pull-requests");
          return pullRequests;
        },
        createReleases: async () => {
          events.push("releases");
          if (releaseError) throw releaseError;
          return releases;
        },
        createPullRequests: async () => {
          events.push("pull-requests");
          return pullRequests;
        },
      };
    },
    writeOutput: (output) => {
      events.push("output");
      outputs.push(output);
    },
  };
}

test("creates releases before reloading the manifest to create pull requests", async () => {
  const harness = createHarness({
    releases: [{ path: "agent-monitor" }],
    pullRequests: [{ number: 42, title: "chore: release agent-monitor" }],
  });

  const result = await runReleasePlease({
    loadManifest: harness.loadManifest,
    writeOutput: harness.writeOutput,
  });

  assert.deepEqual(harness.events, [
    "load-1",
    "releases",
    "output",
    "load-2",
    "pull-requests",
    "output",
  ]);
  assert.equal(result.releases_created, "true");
  assert.equal(result.prs_created, "true");
  assert.equal(result.pr, JSON.stringify({ number: 42, title: "chore: release agent-monitor" }));
});

test("outputs only paths created by this release invocation", async () => {
  const harness = createHarness({ releases: [{ path: "queens" }, undefined] });

  const result = await runReleasePlease({
    loadManifest: harness.loadManifest,
    writeOutput: harness.writeOutput,
  });

  assert.equal(result.paths_released, '["queens"]');
  assert.equal(result.releases_created, "true");
});

test("dry runs build release and pull request proposals without mutations", async () => {
  const harness = createHarness({
    releases: [{ path: "would-publish", tagName: "would-publish-v1.0.0" }],
    pullRequests: [{ title: "chore: release would-publish", body: "proposed body" }],
  });
  const logs = [];

  const result = await runReleasePlease({
    loadManifest: harness.loadManifest,
    writeOutput: harness.writeOutput,
    dryRun: true,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(harness.events, [
    "load-1",
    "build-releases",
    "load-2",
    "build-pull-requests",
    "output",
  ]);
  assert.equal(result.releases_created, "false");
  assert.equal(result.paths_released, "[]");
  assert.equal(result.prs_created, "false");
  assert.deepEqual(result.proposedReleases, [{ path: "would-publish", tagName: "would-publish-v1.0.0" }]);
  assert.deepEqual(result.proposedPullRequests, [
    { title: "chore: release would-publish", body: "proposed body" },
  ]);
  assert.match(logs[0], /would-publish \(would-publish-v1\.0\.0\)/);
  assert.match(logs[1], /chore: release would-publish/);
});

test("release failures prevent manifest reload and pull request creation", async () => {
  const harness = createHarness({ releaseError: new Error("release failed") });

  await assert.rejects(
    runReleasePlease({ loadManifest: harness.loadManifest, writeOutput: harness.writeOutput }),
    /release failed/,
  );
  assert.deepEqual(harness.events, ["load-1", "releases"]);
});

test("manifest reload failures prevent pull request creation", async () => {
  const harness = createHarness({ reloadError: new Error("reload failed") });

  await assert.rejects(
    runReleasePlease({ loadManifest: harness.loadManifest, writeOutput: harness.writeOutput }),
    /reload failed/,
  );
  assert.deepEqual(harness.events, ["load-1", "releases", "output", "load-2"]);
});

test("requires GitHub workflow environment before client creation", () => {
  assert.throws(() => readOptions({}), /GITHUB_REPOSITORY is required/);
  assert.throws(
    () => readOptions({ GITHUB_REPOSITORY: "owner/repo" }),
    /GITHUB_TOKEN is required/,
  );
  assert.throws(
    () =>
      readOptions({
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_TOKEN: "token",
      }),
    /GITHUB_OUTPUT is required/,
  );
  assert.throws(
    () =>
      readOptions({
        GITHUB_REPOSITORY: "owner/repo/extra",
        GITHUB_TOKEN: "token",
        GITHUB_OUTPUT: "output",
      }),
    /owner\/repo form/,
  );
});
