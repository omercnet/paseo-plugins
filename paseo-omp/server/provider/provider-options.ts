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

/** Parse the public providerOptions migration shape and reject unsupported legacy fields. */
export function parseOmpProviderOptions(input: unknown): ParsedOmpProviderOptions {
  let options: ParsedOmpProviderOptions;
  try {
    options = OmpProviderOptionsSchema.parse(input ?? {});
  } catch (error) {
    if (error instanceof ZodError) throw invalidProviderOptions(error);
    throw error;
  }

  if (options.models !== undefined || options.additionalModels !== undefined) {
    throw new OmpPublicError(
      "OMP model overrides cannot be migrated: @getpaseo/plugin 0.8 catalog requests do not expose providerOptions and Paseo does not merge configured models into plugin providers",
    );
  }
  if (options.disallowedTools !== undefined) {
    throw new OmpPublicError(
      "OMP disallowedTools cannot be migrated: @getpaseo/plugin 0.8 toolPolicy supports MCP preapproval but has no generic tool deny-list semantics",
    );
  }
  return options;
}
