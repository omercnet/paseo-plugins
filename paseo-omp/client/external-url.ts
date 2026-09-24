import { openExternalUrl } from "@getpaseo/plugin/client";
import { validatedHttpUrl } from "../shared/external-url";

export function openOmpExternalUrl(url: string): Promise<void> {
  return openExternalUrl(validatedHttpUrl(url));
}
