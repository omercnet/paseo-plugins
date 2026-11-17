const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  max: "Max",
  team: "Team",
  business: "Business",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
};

/**
 * Plan and organization badges for one login, e.g. ["Business", "Example Team"] or ["Personal"].
 * `plan` is the raw plan OMP's usage report names (Codex `planType`, Copilot `plan`).
 */
export function accountTags(input: {
  plan: string | null;
  organization: string | null;
  email: string | null;
}): string[] {
  const { plan, organization, email } = input;
  const tags: string[] = [];
  if (plan) {
    // An own-property lookup: a plan named like an Object member ("constructor") is still a plan.
    const key = plan.toLowerCase();
    tags.push(
      Object.hasOwn(PLAN_LABELS, key)
        ? PLAN_LABELS[key]
        : plan.charAt(0).toUpperCase() + plan.slice(1),
    );
  }
  // Codex reports its plan as the organization name too; that is not an organization.
  if (organization && organization.toLowerCase() !== plan?.toLowerCase()) {
    // Anthropic names a personal account's default organization after its email.
    tags.push(email && organization === `${email}'s Organization` ? "Personal" : organization);
  }
  return [...new Set(tags)];
}
