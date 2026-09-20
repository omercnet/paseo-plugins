import { z } from "zod";
import { utf8Bytes } from "./security";

export const MAX_ID_LENGTH = 256;
export const MAX_NAME_LENGTH = 256;
export const MAX_MODEL_SELECTOR_BYTES = MAX_NAME_LENGTH * 2 + 1;
export const MAX_TEXT_LENGTH = 1024 * 1024;
export const MAX_SYSTEM_PROMPT_LENGTH = 64 * 1024;
export const MAX_PATH_LENGTH = 4_096;

export const OmpThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function validateBoundedText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) === 0 ||
    utf8Bytes(value) > maxBytes ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid OMP ${field}`);
  }
  return value;
}
