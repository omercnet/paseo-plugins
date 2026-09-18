import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("./validate-release-identity.mjs", import.meta.url));

function runValidation(t, tagSha, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-identity-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const directory = options.directory ?? "agent-crew";
  const component = options.component ?? directory;
  const version = options.version ?? "0.2.4";
  const tag = options.tag ?? `${component}-v${version}`;
  const expectedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: options.name ?? "@omercnet/paseo-agent-crew", version }),
  );
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_TAG_SHA\"\n");
  chmodSync(gh, 0o755);

  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DIRECTORY: directory,
      FAKE_TAG_SHA: tagSha,
      GITHUB_REPOSITORY: "omercnet/paseo-plugins",
      PATH: `${bin}:${process.env.PATH}`,
      RELEASE_OUTPUTS: JSON.stringify({
        [`${directory}--tag_name`]: tag,
        [`${directory}--sha`]: options.releaseSha ?? expectedSha,
      }),
      SHA: expectedSha,
    },
  });
}

test("accepts a release tag that resolves to the release commit", (t) => {
  const result = runValidation(t, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  assert.equal(result.status, 0, result.stderr);
});

test("rejects a release tag that resolves to a different commit", (t) => {
  const result = runValidation(t, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /resolves to b{40}, expected a{40}/);
});

test("accepts a release component that differs from its package directory", (t) => {
  const result = runValidation(t, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
    component: "shared-browser",
    directory: "paseo-shared-browser",
    name: "@omercnet/paseo-shared-browser",
    version: "0.3.1",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects a Release Please SHA that differs from the workflow commit", (t) => {
  const result = runValidation(t, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
    releaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release Please reported b{40}.*expected a{40}/);
});
