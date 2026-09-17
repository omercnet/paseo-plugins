import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("./validate-release-identity.mjs", import.meta.url));

function runValidation(t, tagSha) {
  const root = mkdtempSync(join(tmpdir(), "release-identity-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@omercnet/paseo-agent-crew", version: "0.2.4" }),
  );
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_TAG_SHA\"\n");
  chmodSync(gh, 0o755);

  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DIRECTORY: "agent-crew",
      EXPECTED_NAME: "@omercnet/paseo-agent-crew",
      FAKE_TAG_SHA: tagSha,
      GITHUB_REPOSITORY: "omercnet/paseo-plugins",
      PATH: `${bin}:${process.env.PATH}`,
      SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      TAG: "agent-crew-v0.2.4",
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
  assert.match(
    result.stderr,
    /resolves to b{40}, expected a{40}/,
  );
});
