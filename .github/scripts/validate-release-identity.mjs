import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const directory = requiredEnvironment("DIRECTORY");
const component = process.env.COMPONENT || directory;
const expectedName = requiredEnvironment("EXPECTED_NAME");
const tag = requiredEnvironment("TAG");
const expectedSha = requiredEnvironment("SHA");
const repository = requiredEnvironment("GITHUB_REPOSITORY");
const tagPrefix = `${component}-v`;
const version = tag.startsWith(tagPrefix) ? tag.slice(tagPrefix.length) : "";

if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid release tag: ${tag}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.name !== expectedName) {
  throw new Error(`Package name ${packageJson.name} does not match ${expectedName}`);
}
if (packageJson.version !== version) {
  throw new Error(`Package version ${packageJson.version} does not match ${version}`);
}

const tagSha = execFileSync(
  "gh",
  ["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"],
  { encoding: "utf8" },
).trim();
if (tagSha !== expectedSha) {
  throw new Error(`Release tag ${tag} resolves to ${tagSha}, expected ${expectedSha}`);
}
