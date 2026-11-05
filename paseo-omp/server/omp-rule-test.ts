import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { OmpRuleTestHit, testOmpRules } from "../shared/omp-rules";
import {
  inOmpScope,
  type OmpRulesDependencies,
  OmpRulesError,
  ompCommandDependencies,
  runJson,
} from "./omp-rules";
import { OmpPublicError } from "./provider/security";

const MAX_HITS = 100;
const MAX_TEXT_CHARS = 2_000;
const MAX_PATTERNS = 20;

const Patterns = z
  .array(z.string())
  .default([])
  .transform((list) => list.slice(0, MAX_PATTERNS).map((text) => text.slice(0, MAX_TEXT_CHARS)));

/** `omp ttsr test --json`: the rules that fired are `triggered`; `notTriggered` is not needed. */
const TestOutputSchema = z.object({
  evaluated: z.number().int().nonnegative(),
  triggered: z.array(z.unknown()),
});

const TriggeredSchema = z.object({
  name: z.string().min(1).max(256),
  path: z.string().max(4_096),
  sourceProvider: z.string().max(128),
  matched: z.object({ regex: Patterns, ast: Patterns }),
});

export async function testOmpRulesWithDependencies(
  input: RpcInput<typeof testOmpRules>,
  dependencies: OmpRulesDependencies,
): Promise<
  | { status: "ready"; evaluated: number; triggered: OmpRuleTestHit[] }
  | { status: "error"; message: string }
> {
  try {
    const executable = await dependencies.resolveExecutable();
    if (!executable) throw new OmpRulesError("The omp command was not found on this host");
    // The snippet goes over stdin and the optional values are `--flag=value`, so neither can be
    // read as another option. No shell is involved.
    const args = [
      "ttsr",
      "test",
      "--json",
      "--file",
      "-",
      ...(input.source ? [`--source=${input.source}`] : []),
      ...(input.path ? [`--path=${input.path}`] : []),
    ];
    const raw = await inOmpScope(input.cwd, dependencies, (runIn) =>
      runJson(dependencies, executable, args, runIn, input.snippet),
    );
    const output = TestOutputSchema.safeParse(raw);
    if (!output.success) throw new OmpRulesError("omp ttsr test gave output the plugin can't read");
    const triggered = output.data.triggered
      .flatMap((entry): OmpRuleTestHit[] => {
        const parsed = TriggeredSchema.safeParse(entry);
        if (!parsed.success) return [];
        const { name, path, sourceProvider, matched } = parsed.data;
        return [{ name, provider: sourceProvider, path, regex: matched.regex, ast: matched.ast }];
      })
      .slice(0, MAX_HITS);
    // Fired rules that all fail to parse mean the output changed shape; "none fired" would be false.
    if (output.data.triggered.length > 0 && triggered.length === 0) {
      throw new OmpRulesError("omp ttsr test gave output the plugin can't read");
    }
    return { status: "ready", evaluated: output.data.evaluated, triggered };
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

export function resolveTestOmpRules(input: RpcInput<typeof testOmpRules>) {
  return testOmpRulesWithDependencies(input, ompCommandDependencies);
}
