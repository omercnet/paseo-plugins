import * as paseoClient from "@getpaseo/plugin/client";
import { Linking } from "react-native";
import { selectExternalUrlOpener, validatedHttpUrl } from "../shared/external-url";

const paseoOpenExternalUrl =
  "openExternalUrl" in paseoClient && typeof paseoClient.openExternalUrl === "function"
    ? paseoClient.openExternalUrl
    : undefined;
const openExternalUrl = selectExternalUrlOpener(paseoOpenExternalUrl, (url) =>
  Linking.openURL(url),
);

export function openOmpExternalUrl(url: string): Promise<void> {
  return openExternalUrl(validatedHttpUrl(url));
}
