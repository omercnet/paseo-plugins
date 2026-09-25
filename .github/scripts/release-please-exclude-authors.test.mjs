import assert from "node:assert/strict";
import test from "node:test";

import { parseConventionalCommits } from "release-please/build/src/commit.js";
import { DefaultChangelogNotes } from "release-please/build/src/changelog-notes/default.js";

import {
  ExcludeAuthors,
  captureCommitAuthors,
  shouldExcludeAuthor,
  validateExcludeAuthorsConfig,
} from "./release-please-exclude-authors.mjs";

const config = validateExcludeAuthorsConfig({
  usernames: ["omercnet"],
  "exclude-bots": true,
});

function process(commits, authorsBySha = new Map()) {
  const plugin = new ExcludeAuthors(
    {},
    "main",
    {},
    {
      usernames: ["omercnet"],
      "exclude-bots": true,
    },
    authorsBySha,
  );
  return plugin.processCommits(commits);
}

test("excludes configured owners case-insensitively without dropping commits", () => {
  const commits = [
    { sha: "one", author: { name: "Omer", username: "OMERCNET" } },
    { sha: "two", author: { name: "Contributor", username: "someone-else" } },
  ];

  const result = process(commits);

  assert.equal(result, commits);
  assert.deepEqual(result.map(({ sha }) => sha), ["one", "two"]);
  assert.equal(result[0].author, undefined);
  assert.deepEqual(result[1].author, { name: "Contributor", username: "someone-else" });
});

test("excludes generic bot identities including bots without GitHub usernames", () => {
  for (const author of [
    { name: "Release Bot", username: "release-service[BOT]" },
    { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" },
    { name: "Automation", email: "bot[bot]@users.noreply.github.com" },
  ]) {
    assert.equal(shouldExcludeAuthor(author, config), true);
  }
});

test("trusts a resolved human username over bot-like fallback metadata", () => {
  assert.equal(
    shouldExcludeAuthor(
      {
        name: "Alice[bot]",
        email: "alice[bot]@users.noreply.github.com",
        username: "alice",
      },
      config,
    ),
    false,
  );
});

test("preserves external and unresolved non-bot authors", () => {
  const commits = [
    { sha: "human", author: { name: "Ava", username: "ava" } },
    { sha: "unresolved", author: { name: "Ava", email: "ava@example.test" } },
    { sha: "missing" },
  ];

  const result = process(commits);

  assert.deepEqual(result, commits);
  assert.deepEqual(result[0].author, { name: "Ava", username: "ava" });
  assert.deepEqual(result[1].author, { name: "Ava", email: "ava@example.test" });
  assert.equal(result[2].author, undefined);
});

test("restores authors lost by the Release Please manifest pipeline before filtering", async () => {
  const rawCommits = [
    {
      sha: "owner-sha",
      message: "feat: owner change",
      files: ["package.json"],
      author: { name: "Omer", username: "omercnet" },
    },
    {
      sha: "contributor-sha",
      message: "fix: contributor change",
      files: ["package.json"],
      author: { name: "Contributor", username: "outside-user" },
    },
  ];
  const authorsBySha = new Map();
  const github = {
    async *mergeCommitIterator() {
      yield* rawCommits;
    },
  };
  captureCommitAuthors(github, authorsBySha);

  const collected = [];
  for await (const commit of github.mergeCommitIterator()) {
    collected.push({
      sha: commit.sha,
      message: commit.message,
      files: commit.files,
      pullRequest: commit.pullRequest,
    });
  }
  const commits = process(parseConventionalCommits(collected), authorsBySha);
  const notes = await new DefaultChangelogNotes().buildNotes(commits, {
    owner: "example",
    repository: "repo",
    version: "1.0.0",
    previousTag: "v0.9.0",
    currentTag: "v1.0.0",
    targetBranch: "main",
    includeCommitAuthors: true,
  });

  assert.match(notes, /owner change/);
  assert.doesNotMatch(notes, /@omercnet/);
  assert.match(notes, /contributor change/);
  assert.match(notes, /@outside-user/);
});

test("rejects malformed plugin configuration", () => {
  for (const config of [null, [], { usernames: [""] }, { usernames: "omercnet" }, { "exclude-bots": "true" }]) {
    assert.throws(() => validateExcludeAuthorsConfig(config), TypeError);
  }
});
