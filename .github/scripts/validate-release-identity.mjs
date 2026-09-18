import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const directory = requiredEnvironment("DIRECTORY");
const expectedSha = requiredEnvironment("SHA");
const repository = requiredEnvironment("GITHUB_REPOSITORY");
const releaseOutputs = JSON.parse(requiredEnvironment("RELEASE_OUTPUTS"));
const tag = releaseOutputs[`${directory}--tag_name`];
const releaseSha = releaseOutputs[`${directory}--sha`];
if (!tag || !releaseSha) {
  throw new Error(`Release Please omitted tag or SHA outputs for ${directory}`);
}
if (releaseSha !== expectedSha) {
  throw new Error(`Release Please reported ${releaseSha} for ${directory}, expected ${expectedSha}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const suffix = `-v${packageJson.version}`;
const component = tag.endsWith(suffix) ? tag.slice(0, -suffix.length) : "";
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(component)) {
  throw new Error(`Invalid release tag: ${tag}`);
}

const tagSha = execFileSync(
  "gh",
  ["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"],
  { encoding: "utf8" },
).trim();
if (tagSha !== expectedSha) {
  throw new Error(`Release tag ${tag} resolves to ${tagSha}, expected ${expectedSha}`);
}
