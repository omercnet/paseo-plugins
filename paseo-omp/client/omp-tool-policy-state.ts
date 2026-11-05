import {
  type OmpBashRule,
  OmpBashRuleSchema,
  OmpBashRulesSchema,
  OmpRestrictedFoldersSchema,
  type OmpToolApproval,
  OmpToolApprovalSchema,
  OmpToolPoliciesSchema,
} from "../shared/omp-settings";

export type ToolPolicies = Record<string, OmpToolApproval>;

export interface ToolPolicyState {
  policies: ToolPolicies;
  rules: OmpBashRule[];
}

/**
 * OMP does not validate these values when it stores them. Keep only entries Apply would accept,
 * so one stored bad entry cannot make every later save fail.
 */
export function readToolPolicies(value: unknown): ToolPolicies {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const policies: ToolPolicies = {};
  for (const [tool, approval] of Object.entries(value)) {
    const parsed = OmpToolPoliciesSchema.safeParse({ [tool]: approval });
    if (parsed.success) Object.assign(policies, parsed.data);
  }
  return policies;
}

export function readBashRules(value: unknown): OmpBashRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): OmpBashRule[] => {
    if (entry === null || typeof entry !== "object") return [];
    const { match, approval } = entry as { match?: unknown; approval?: unknown };
    const parsed = OmpBashRuleSchema.safeParse({ match, approval });
    return parsed.success ? [parsed.data] : [];
  });
}

/** A rule being edited can be momentarily invalid, for example an emptied pattern, and must stay on screen. */
export function readBashRuleDraft(value: unknown): OmpBashRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): OmpBashRule[] => {
    if (entry === null || typeof entry !== "object") return [];
    const { match, approval } = entry as { match?: unknown; approval?: unknown };
    const parsed = OmpToolApprovalSchema.safeParse(approval);
    return typeof match === "string" && parsed.success ? [{ match, approval: parsed.data }] : [];
  });
}

export function readFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const folders = value.filter((item) => OmpRestrictedFoldersSchema.safeParse([item]).success);
  return [...new Set(folders as string[])];
}

/** Rules are first match wins, so moving a rule changes which one applies. */
export function moveRule<T>(rules: readonly T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (target < 0 || target >= rules.length) return [...rules];
  const next = [...rules];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return next;
  next.splice(target, 0, moved);
  return next;
}

/** Effects of the saved policy that a user would not guess from the approval mode picker. */
export function policyWarnings({ policies, rules }: ToolPolicyState): string[] {
  const warnings: string[] = [];
  if (policies.bash === "allow") {
    warnings.push(
      "Bash is set to Allow, so it runs without asking in every mode, including Always Ask.",
    );
  }
  if (rules.some((rule) => rule.approval === "allow")) {
    warnings.push("Commands matching an Allow rule run without asking, even in Always Ask.");
  }
  const asks =
    Object.values(policies).includes("prompt") || rules.some((rule) => rule.approval === "prompt");
  if (asks) {
    warnings.push(
      "Subagents cannot answer prompts, so a call that matches an Ask rule fails there.",
    );
  }
  return warnings;
}

/** Add is offered only when the whole resulting list would pass the schema Apply uses. */
export function canAddToolRule(policies: ToolPolicies, tool: string): boolean {
  return (
    !Object.hasOwn(policies, tool) &&
    OmpToolPoliciesSchema.safeParse({ ...policies, [tool]: "prompt" }).success
  );
}

export function canAddBashRule(rules: readonly OmpBashRule[], match: string): boolean {
  return OmpBashRulesSchema.safeParse([...rules, { match, approval: "prompt" }]).success;
}
