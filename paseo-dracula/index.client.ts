import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext) {
  client.addTheme({
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
  });

  client.addTheme({
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
  });

  return () => {};
}
