import { ManifestPlugin } from "release-please/build/src/plugin.js";
import { registerPlugin } from "release-please";

export const PLUGIN_TYPE = "exclude-authors";

export function validateExcludeAuthorsConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(`${PLUGIN_TYPE} plugin config must be an object`);
  }

  const usernames = config.usernames ?? [];
  if (
    !Array.isArray(usernames) ||
    usernames.some((username) => typeof username !== "string" || username.trim() === "")
  ) {
    throw new TypeError(`${PLUGIN_TYPE}.usernames must be an array of non-empty strings`);
  }
  if (config["exclude-bots"] !== undefined && typeof config["exclude-bots"] !== "boolean") {
    throw new TypeError(`${PLUGIN_TYPE}.exclude-bots must be a boolean`);
  }

  return {
    usernames: new Set(usernames.map((username) => username.toLowerCase())),
    excludeBots: config["exclude-bots"] ?? false,
  };
}

function endsWithBot(value) {
  return typeof value === "string" && /\[bot\]$/i.test(value);
}

function hasGitHubBotNoreplyEmail(email) {
  if (typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  if (at < 0 || email.slice(at + 1).toLowerCase() !== "users.noreply.github.com") return false;
  return endsWithBot(email.slice(0, at));
}

export function shouldExcludeAuthor(author, config) {
  if (!author) return false;
  if (typeof author.username === "string") {
    if (config.usernames.has(author.username.toLowerCase())) return true;
    return config.excludeBots && endsWithBot(author.username);
  }
  return (
    config.excludeBots &&
    (endsWithBot(author.name) || hasGitHubBotNoreplyEmail(author.email))
  );
}

export class ExcludeAuthors extends ManifestPlugin {
  constructor(github, targetBranch, repositoryConfig, config, authorsBySha) {
    super(github, targetBranch, repositoryConfig, config.logger);
    this.config = validateExcludeAuthorsConfig(config);
    this.authorsBySha = authorsBySha;
  }

  processCommits(commits) {
    for (const commit of commits) {
      const author = commit.author ?? this.authorsBySha.get(commit.sha);
      commit.author = shouldExcludeAuthor(author, this.config) ? undefined : author;
    }
    return commits;
  }
}

// Release Please 17.6.0 drops author metadata while collecting and parsing
// commits. Capture it at the GitHub boundary so the plugin can restore it by SHA.
export function captureCommitAuthors(github, authorsBySha) {
  const mergeCommitIterator = github.mergeCommitIterator.bind(github);
  github.mergeCommitIterator = async function* (...args) {
    for await (const commit of mergeCommitIterator(...args)) {
      if (commit.author) authorsBySha.set(commit.sha, commit.author);
      yield commit;
    }
  };
}

export function registerExcludeAuthorsPlugin(authorsBySha) {
  registerPlugin(PLUGIN_TYPE, (options) =>
    new ExcludeAuthors(
      options.github,
      options.targetBranch,
      options.repositoryConfig,
      options,
      authorsBySha,
    ),
  );
}
