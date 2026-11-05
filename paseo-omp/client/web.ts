import { Platform } from "react-native";

declare const document: {
  createElement(tag: "a"): { href: string; download: string; click(): void };
};
declare function atob(data: string): string;
declare class Blob {
  constructor(parts: Uint8Array[], options: { type: string });
}
declare const URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };

/** Saving a file needs the browser; the desktop app and the web client both run it. */
export const canDownloadFiles = Platform.OS === "web";

const BASE64_DATA_URI = /^data:([^;,]+);base64,(.*)$/su;
const REVOKE_DELAY_MS = 60_000;

/**
 * Saves a `data:` URI. Browsers refuse to download a data URL past about 2 MiB, so the bytes go
 * through a Blob and an object URL instead.
 */
export function downloadDataUri(uri: string, fileName: string): void {
  if (!canDownloadFiles) return;
  const match = BASE64_DATA_URI.exec(uri);
  const bytes = match ? Uint8Array.from(atob(match[2] ?? ""), (char) => char.charCodeAt(0)) : null;
  const objectUrl =
    match && bytes ? URL.createObjectURL(new Blob([bytes], { type: match[1] ?? "" })) : null;
  const link = document.createElement("a");
  link.href = objectUrl ?? uri;
  link.download = fileName;
  link.click();
  // Safari and Firefox can start the download after the click returns, so revoke late.
  if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
}
