import { Platform } from "react-native";

declare const document: {
  createElement(tag: "a"): { href: string; download: string; click(): void };
};

/** Saving a file needs the browser; the desktop app and the web client both run it. */
export const canDownloadFiles = Platform.OS === "web";

export function downloadDataUri(uri: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = uri;
  link.download = fileName;
  link.click();
}
