import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GitHub, Manifest } from "release-please";

import {
  captureCommitAuthors,
  registerExcludeAuthorsPlugin,
} from "./release-please-exclude-authors.mjs";

const CONFIG_FILE = "release-please-config.json";
const MANIFEST_FILE = ".release-please-manifest.json";

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readOptions(environment = process.env, argv = process.argv.slice(2)) {
  const repository = requiredEnvironment(environment, "GITHUB_REPOSITORY");
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repo form");
  }

  return {
    token: requiredEnvironment(environment, "GITHUB_TOKEN"),
    owner,
    repo,
    outputPath: requiredEnvironment(environment, "GITHUB_OUTPUT"),
    targetBranch: environment.GITHUB_REF_NAME || "main",
    dryRun: argv.includes("--dry-run"),
  };
}

export function outputsForReleases(releases) {
  const created = releases.filter(Boolean);
  return {
    releases_created: String(created.length > 0),
    paths_released: JSON.stringify(created.map((release) => release.path || ".")),
  };
}

export function outputsForPullRequests(pullRequests) {
  const created = pullRequests.filter(Boolean);
  return {
    prs_created: String(created.length > 0),
    pr: created[0] ? JSON.stringify(created[0]) : "",
    prs: JSON.stringify(created),
  };
}

export function writeOutputs(outputPath, outputs) {
  appendFileSync(outputPath, `${Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`);
}

export async function runReleasePlease({
  loadManifest,
  writeOutput,
  dryRun = false,
  log = () => {},
}) {
  if (dryRun) {
    const releaseManifest = await loadManifest();
    const proposedReleases = (await releaseManifest.buildReleases()).filter(Boolean);
    const pullRequestManifest = await loadManifest();
    const proposedPullRequests = (await pullRequestManifest.buildPullRequests()).filter(Boolean);
    log(
      `Dry run: proposed releases: ${proposedReleases
        .map((release) => `${release.path || "."} (${release.tagName ?? release.version ?? "no tag"})`)
        .join(", ") || "none"}`,
    );
    log(
      `Dry run: proposed pull requests: ${proposedPullRequests
        .map((pullRequest) => pullRequest.title || "untitled")
        .join(", ") || "none"}`,
    );
    const outputs = {
      ...outputsForReleases([]),
      ...outputsForPullRequests([]),
    };
    writeOutput(outputs);
    return { ...outputs, proposedReleases, proposedPullRequests };
  }

  const releaseManifest = await loadManifest();
  const releases = await releaseManifest.createReleases();
  const releaseOutputs = outputsForReleases(releases);
  writeOutput(releaseOutputs);

  const pullRequestManifest = await loadManifest();
  const pullRequests = await pullRequestManifest.createPullRequests();
  const outputs = { ...releaseOutputs, ...outputsForPullRequests(pullRequests) };
  writeOutput(outputsForPullRequests(pullRequests));
  return outputs;
}

export async function main(environment = process.env, argv = process.argv.slice(2)) {
  const options = readOptions(environment, argv);
  const authorsBySha = new Map();
  const github = await GitHub.create({
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    defaultBranch: options.targetBranch,
  });
  captureCommitAuthors(github, authorsBySha);
  registerExcludeAuthorsPlugin(authorsBySha);
  const loadManifest = () =>
    Manifest.fromManifest(
      github,
      options.targetBranch,
      CONFIG_FILE,
      MANIFEST_FILE,
    );

  return runReleasePlease({
    loadManifest,
    writeOutput: (outputs) => writeOutputs(options.outputPath, outputs),
    dryRun: options.dryRun,
    log: console.log,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`release-please failed: ${error.message}`);
    process.exitCode = 1;
  });
}
