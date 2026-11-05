import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";
import { OmpStoreSchema } from "./omp-store";

/** A `disabledExtensions` entry for a skill reads `skill:<name>`. */
export const SKILL_ENTRY_PREFIX = "skill:";

export const OmpSkillLevelSchema = z.enum(["project", "user", "other"]);
export type OmpSkillLevel = z.infer<typeof OmpSkillLevelSchema>;

export const OmpSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** OMP's provider id, such as `native`, `claude`, or `omp-managed`. */
  source: z.string(),
  level: OmpSkillLevelSchema,
  /** The skill's folder. */
  path: z.string(),
  /** Written by the agent through autolearn (`omp-managed`); only these can be deleted here. */
  managed: z.boolean(),
});
export type OmpSkill = z.infer<typeof OmpSkillSchema>;

/** The two lists that turn a skill off. A `disabledExtensions` entry reads `skill:<name>`. */
export const OmpSkillListSchema = z.enum(["skills.ignoredSkills", "disabledExtensions"]);
export type OmpSkillList = z.infer<typeof OmpSkillListSchema>;

/** OMP drops turned-off skills from its listing, so only the list entry is known. */
export const OmpSkillOffSchema = z.object({
  list: OmpSkillListSchema,
  /** The entry as written: a name or a glob, with `skill:` in `disabledExtensions`. */
  entry: z.string(),
});
export type OmpSkillOff = z.infer<typeof OmpSkillOffSchema>;

export const OmpSkillsListSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    skills: z.array(OmpSkillSchema),
    off: z.array(OmpSkillOffSchema),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type OmpSkillsList = z.infer<typeof OmpSkillsListSchema>;

const OmpSkillsResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

const ScopeSchema = { store: OmpStoreSchema.optional(), cwd: OmpWorkspaceCwdSchema.optional() };

export const listOmpSkills = defineRpc({
  name: "paseo-omp.list-skills",
  input: z.object(ScopeSchema).strict(),
  output: OmpSkillsListSchema,
});

/** Off adds `entry` to `list`; on removes it. A workspace writes its own `.omp/config.yml`. */
export const setOmpSkillEnabled = defineRpc({
  name: "paseo-omp.set-skill-enabled",
  input: z
    .object({
      ...ScopeSchema,
      list: OmpSkillListSchema,
      entry: z.string().trim().min(1).max(256),
      enabled: z.boolean(),
    })
    .strict(),
  output: OmpSkillsResultSchema,
});

export const deleteOmpManagedSkill = defineRpc({
  name: "paseo-omp.delete-managed-skill",
  input: z
    .object({ store: OmpStoreSchema.optional(), path: z.string().min(1).max(4_096) })
    .strict(),
  output: OmpSkillsResultSchema,
});
