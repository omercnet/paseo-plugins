export function validatedHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Only absolute HTTP(S) URLs are supported.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only absolute HTTP(S) URLs are supported.");
  }
  return url.href;
}
