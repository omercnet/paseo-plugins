import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Maintains exactly one open issue per compatibility lane, identified by its label.
// A failing lane keeps that issue current; a passing lane closes it. Upstream version
// numbers belong in the body, never in the identity, so a daily upstream release does
// not create a new issue for a failure that is already recorded.
const repo = process.env.GITHUB_REPOSITORY;
const label = process.env.COMPAT_LABEL;
const title = process.env.COMPAT_TITLE;
const state = process.env.COMPAT_STATE;
const bodyFile = process.env.COMPAT_BODY_FILE;

if (!(repo && label && title && bodyFile)) {
  throw new Error(
    "report-compat requires GITHUB_REPOSITORY, COMPAT_LABEL, COMPAT_TITLE, and COMPAT_BODY_FILE",
  );
}
if (state !== "failing" && state !== "passing") {
  throw new Error(`COMPAT_STATE must be failing or passing, got ${JSON.stringify(state)}`);
}

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const body = readFileSync(bodyFile, "utf8");

gh(
  "label",
  "create",
  label,
  "--repo",
  repo,
  "--color",
  "d4c5f9",
  "--description",
  "Automated upstream compatibility lane",
  "--force",
);

const [existing] = JSON.parse(
  gh(
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    label,
    "--limit",
    "1",
    "--json",
    "number",
  ),
);

if (state === "passing") {
  if (!existing) {
    process.stdout.write(`${label} is green and has no open issue\n`);
  } else {
    gh("issue", "close", String(existing.number), "--repo", repo, "--comment", body);
    process.stdout.write(`Closed #${existing.number}: ${label} is green\n`);
  }
} else if (existing) {
  gh("issue", "edit", String(existing.number), "--repo", repo, "--title", title, "--body", body);
  process.stdout.write(`Updated #${existing.number} with the current ${label} failure\n`);
} else {
  const created = gh(
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    label,
  );
  process.stdout.write(`Opened ${created.trim()} for ${label}\n`);
}
