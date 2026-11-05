import { z } from "zod";

export const OMP_RULE_NOTICE_KIND = "omp-rule-notice";
export const MAX_OMP_RULE_NOTICE_RULES = 32;
export const OMP_RULE_NAME_MAX_LENGTH = 256;
export const OMP_RULE_MATCH_MAX_LENGTH = 512;

/** OMP rules (TTSR) that fired during one turn, appended below that turn. */
export const ompRuleNoticeSchema = z.object({
  rules: z
    .array(
      z.object({
        name: z.string().min(1).max(OMP_RULE_NAME_MAX_LENGTH),
        matched: z.string().max(OMP_RULE_MATCH_MAX_LENGTH).nullable(),
      }),
    )
    .min(1)
    .max(MAX_OMP_RULE_NOTICE_RULES),
});
export type OmpRuleNotice = z.infer<typeof ompRuleNoticeSchema>;
