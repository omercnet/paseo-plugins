import { describe, expect, test } from "bun:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client";

type ThemeDefinition = Parameters<PluginClientContext["addTheme"]>[0];

describe("Dracula theme contributions", () => {
  test("registers both exact classic variants and returns callable cleanup", () => {
    const registrations: ThemeDefinition[] = [];
    const client = {
      addTheme(theme: ThemeDefinition) {
        registrations.push(theme);
      },
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);

    expect(registrations).toEqual([
      {
        id: "paseo-dracula",
        name: "Dracula",
        appearance: "dark",
        colors: {
          background: "#282A36",
          foreground: "#F8F8F2",
          raised: "#343746",
          control: "#44475A",
          border: "#424450",
          accent: "#BD93F9",
          mutedForeground: "#F8F8F2",
          ring: "#6272A4",
        },
      },
      {
        id: "paseo-alucard",
        name: "Alucard",
        appearance: "light",
        colors: {
          background: "#FFFBEB",
          foreground: "#1F1F1F",
          raised: "#EFEDDC",
          control: "#CFCFDE",
          border: "#ECE9DF",
          accent: "#644AC9",
          mutedForeground: "#1F1F1F",
          ring: "#6C664B",
        },
      },
    ]);
    expect(registrations).toHaveLength(2);
    expect(typeof cleanup).toBe("function");
    expect(cleanup()).toBeUndefined();
  });
});
