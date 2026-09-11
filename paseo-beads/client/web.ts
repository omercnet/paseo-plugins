import { Platform } from "react-native";

declare const document: {
  getElementById(id: string): { focus(): void } | null;
};

export function focusWebElement(id: string): boolean {
  if (Platform.OS !== "web") return false;

  const element = document.getElementById(id);
  if (!element) return false;

  element.focus();
  return true;
}
