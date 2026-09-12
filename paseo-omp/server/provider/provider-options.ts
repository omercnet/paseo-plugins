import { ZodError, type z } from "zod";
import { OmpPublicError } from "./security";
import { OmpProviderOptionsSchema } from "./settings";

export type ParsedOmpProviderOptions = z.infer<typeof OmpProviderOptionsSchema>;

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "providerOptions";
  return `providerOptions.${path.map(String).join(".")}`;
}

function invalidProviderOptions(error: ZodError): OmpPublicError {
  const details = error.issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  return new OmpPublicError(`Invalid OMP provider options: ${details}`);
}

/** Parse and normalize the public providerOptions shape. */
export function parseOmpProviderOptions(input: unknown): ParsedOmpProviderOptions {
  try {
    return OmpProviderOptionsSchema.parse(input ?? {});
  } catch (error) {
    if (error instanceof ZodError) throw invalidProviderOptions(error);
    throw error;
  }
}
