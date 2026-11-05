import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  deleteOmpManagedSkill,
  listOmpSkills,
  type OmpSkill,
  type OmpSkillOff,
  SKILL_ENTRY_PREFIX,
  setOmpSkillEnabled,
} from "../shared/omp-skills";
import type { OmpStore } from "../shared/omp-store";
import { ConfirmModal, describe } from "./omp-accounts-section";
import type { OmpConfigStyles } from "./omp-config-styles";
import { ompStoreKey } from "./omp-store-state";

type Theme = PluginSurfaceProps["theme"];

const SKILLS_KEY = ["paseo-omp", "skills"] as const;

const INFO =
  "OMP hides turned-off skills from its own list, so they are read from skills.ignoredSkills and disabledExtensions. In a workspace, a change is saved to the project's .omp/config.yml with the whole list, because a project list replaces the user list. Changes apply to new sessions, or after an agent reload.";

interface SkillGroup {
  title: string;
  skills: OmpSkill[];
}

function groupSkills(skills: readonly OmpSkill[]): SkillGroup[] {
  const groups: SkillGroup[] = [
    { title: "Project", skills: skills.filter((s) => !s.managed && s.level === "project") },
    { title: "User", skills: skills.filter((s) => !s.managed && s.level === "user") },
    { title: "Learned by the agent", skills: skills.filter((s) => s.managed) },
    { title: "Other", skills: skills.filter((s) => !s.managed && s.level === "other") },
  ];
  return groups.filter((group) => group.skills.length > 0);
}

function skillHint(skill: OmpSkill): string {
  const origin = skill.managed ? "Learned by the agent" : skill.source;
  return skill.description ? `${origin} · ${skill.description}` : origin;
}

function offLabel(off: OmpSkillOff): string {
  return off.list === "disabledExtensions" ? off.entry.slice(SKILL_ENTRY_PREFIX.length) : off.entry;
}

function offHint(off: OmpSkillOff): string {
  const pattern = offLabel(off).includes("*") ? "Pattern, may match several skills · " : "";
  return `${pattern}Listed in ${off.list}`;
}

export function OmpSkillsSection({
  theme,
  styles,
  cwd,
  store,
}: {
  theme: Theme;
  styles: OmpConfigStyles;
  cwd?: string;
  store?: OmpStore;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const load = useRpc(listOmpSkills);
  const setEnabled = useRpc(setOmpSkillEnabled);
  const remove = useRpc(deleteOmpManagedSkill);
  const [pendingDelete, setPendingDelete] = useState<OmpSkill | null>(null);
  const scope = cwd ? { cwd } : {};
  const skills = useQuery({
    queryKey: [...SKILLS_KEY, ompStoreKey(store), cwd ?? "global"],
    queryFn: () => load({ store, ...scope }),
  });
  const toggle = useMutation({
    mutationKey: [...SKILLS_KEY, "toggle"],
    mutationFn: (change: { list: OmpSkillOff["list"]; entry: string; enabled: boolean }) =>
      setEnabled({ store, ...scope, ...change }),
    onSuccess: async (result) => {
      if (result.status === "error") toast.error(result.message);
      await queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
  });
  const del = useMutation({
    mutationKey: [...SKILLS_KEY, "delete"],
    mutationFn: (skill: OmpSkill) => remove({ store, path: skill.path }),
    onSuccess: async (result) => {
      if (result.status === "error") toast.error(result.message);
      else toast.show("Skill deleted", { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
    },
    onError: (error) => toast.error(describe(error)),
    onSettled: () => setPendingDelete(null),
  });

  const list = skills.data;
  const busy = toggle.isPending || del.isPending;
  return (
    <View style={{ gap: 12 }}>
      <SettingsSection title="Skills" info={INFO}>
        <Text style={styles.muted}>
          Skills are listed by omp, in this {cwd ? "workspace" : "user"} scope.
        </Text>
      </SettingsSection>
      {skills.isLoading ? <Text style={styles.muted}>Loading skills...</Text> : null}
      {skills.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not list OMP's skills.
        </Text>
      ) : null}
      {list?.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {list.message}
        </Text>
      ) : null}
      {list?.status === "ready" ? (
        <>
          {list.skills.length === 0 ? <Text style={styles.muted}>No skills found</Text> : null}
          {groupSkills(list.skills).map((group) => (
            <SettingsSection key={group.title} title={group.title}>
              <SettingsCard>
                {group.skills.map((skill) => (
                  <View key={`${skill.source}/${skill.path}`}>
                    <SettingsSwitch
                      label={skill.name}
                      hint={skillHint(skill)}
                      value
                      disabled={busy}
                      onValueChange={() =>
                        toggle.mutate({
                          list: "skills.ignoredSkills",
                          entry: skill.name,
                          enabled: false,
                        })
                      }
                    />
                    {skill.managed ? (
                      <SettingsAction
                        label={`Delete ${skill.name}`}
                        hint="Deletes the skill folder the agent wrote, for the terminal too"
                        actionLabel="Delete"
                        disabled={busy}
                        onPress={() => setPendingDelete(skill)}
                      />
                    ) : null}
                  </View>
                ))}
              </SettingsCard>
            </SettingsSection>
          ))}
          <SettingsSection title="Turned off">
            <SettingsCard>
              {list.off.length === 0 ? (
                <Text style={styles.muted}>No skills turned off</Text>
              ) : (
                list.off.map((off) => (
                  <SettingsSwitch
                    key={`${off.list}/${off.entry}`}
                    label={offLabel(off)}
                    hint={offHint(off)}
                    value={false}
                    disabled={busy}
                    onValueChange={() => toggle.mutate({ ...off, enabled: true })}
                  />
                ))
              )}
            </SettingsCard>
          </SettingsSection>
        </>
      ) : null}
      {pendingDelete ? (
        <ConfirmModal
          styles={styles}
          theme={theme}
          title={`Delete ${pendingDelete.name}?`}
          body="This deletes the skill folder from OMP's managed skills, for the terminal too. It cannot be undone."
          confirmLabel="Delete"
          tone="danger"
          busy={del.isPending}
          onConfirm={() => del.mutate(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </View>
  );
}
