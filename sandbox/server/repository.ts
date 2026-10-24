export interface Repository {
  url: string;
  /** Name of the checkout directory under the sandbox home. */
  directory: string;
}

/** `owner/repo` on GitHub or an https URL, normalized. */
export function parseRepository(input: string): Repository {
  const trimmed = input.trim();
  const url = /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? `https://github.com/${trimmed}` : trimmed;
  if (!URL.canParse(url)) throw new Error("Enter a project as owner/repo or an https URL.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Use an https URL without a username or password.");
  const directory = parsed.pathname
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/, "")
    .replace(/[^\w.-]/g, "");
  if (!directory || directory.startsWith(".")) throw new Error("That URL does not name a project.");
  return { url: parsed.toString(), directory };
}
