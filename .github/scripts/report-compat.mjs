import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Maintains exactly one open issue per compatibility lane, identified by its label.
// A failing lane keeps that issue current; a passing lane closes it. Upstream version
// numbers belong in the body, never in the identity, so a daily upstream release does
// not create a new issue for a failure that is already recorded.
export function reportCompat({ gh, repo, label, title, state, body }) {
  if (!(repo && label && title && typeof body === "string")) {
    throw new Error("reportCompat requires repo, label, title, and body");
  }
  if (state !== "failing" && state !== "passing") {
    throw new Error(`COMPAT_STATE must be failing or passing, got ${JSON.stringify(state)}`);
  }

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
    if (!existing) return { action: "noop" };
    // Retitle before closing so the closed record does not keep a stale failing title.
    gh("issue", "edit", String(existing.number), "--repo", repo, "--title", title);
    gh("issue", "close", String(existing.number), "--repo", repo, "--comment", body);
    return { action: "closed", number: existing.number };
  }

  if (existing) {
    gh("issue", "edit", String(existing.number), "--repo", repo, "--title", title, "--body", body);
    return { action: "updated", number: existing.number };
  }

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
  return { action: "created", url: created.trim() };
}

function main() {
  const bodyFile = process.env.COMPAT_BODY_FILE;
  if (!bodyFile) throw new Error("report-compat requires COMPAT_BODY_FILE");

  const result = reportCompat({
    gh: (...args) => execFileSync("gh", args, { encoding: "utf8" }),
    repo: process.env.GITHUB_REPOSITORY,
    label: process.env.COMPAT_LABEL,
    title: process.env.COMPAT_TITLE,
    state: process.env.COMPAT_STATE,
    body: readFileSync(bodyFile, "utf8"),
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
