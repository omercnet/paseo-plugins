import {
  type PluginSurfaceProps,
  type SettingsState,
  usePaseo,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  type AutoLaunchMode,
  type CwdMode,
  DEFAULT_PR_RADAR_SETTINGS,
  PrRadarSettingsSchema,
  prRadarSettings,
} from "../shared/settings";
import { listLocalDirs } from "../shared/viewer-scope";

type ReadySettings = Extract<SettingsState<typeof prRadarSettings.schema>, { status: "ready" }>;

interface ComboOption {
  label: string;
  value: string;
  detail?: string;
}

const CWD_MODE_OPTIONS: readonly { label: string; value: CwdMode }[] = [
  { label: "Worktree (CWD-WORKTREE)", value: "CWD-WORKTREE" },
  { label: "Base checkout (CWD-BASE)", value: "CWD-BASE" },
];

const AUTO_LAUNCH_OPTIONS: readonly { label: string; value: AutoLaunchMode }[] = [
  { label: "Always prompt before starting", value: "prompt" },
  { label: "Auto-launch when local checkout exists", value: "existing_only" },
  { label: "Auto-launch (clone & create worktree if needed)", value: "existing_or_clone" },
];

const EFFORT_OPTIONS: readonly { label: string; value: string }[] = [
  { label: "Profile / provider default", value: "" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high (xhigh)", value: "xhigh" },
];

const KNOWN_PROVIDERS: readonly string[] = [
  "claude",
  "codex",
  "pi",
  "antigravity",
  "gemini",
  "hermes",
  "cursor",
];

const KNOWN_MODELS: readonly string[] = [
  "sonnet",
  "opus",
  "haiku",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-5.4",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const KNOWN_MODES: readonly string[] = [
  "default",
  "bypassPermissions",
  "plan",
  "acceptEdits",
  "dontAsk",
  "auto",
];

const KNOWN_CONTEXT_MODES: readonly string[] = ["full", "compact", "minimal", "none"];

const KNOWN_ROUTING_SCRIPTS: readonly ComboOption[] = [
  {
    label: "None (use static defaults above)",
    value: "",
  },
  {
    label: "djbclark-ade: pr-radar-route",
    value: "~/src/djbclark-ade/bin/pr-radar-route",
  },
  {
    label: "Bundled copy: pr-radar-route.py",
    value: "~/src/paseo-plugins-omercnet/pr-radar/examples/pr-radar-route.py",
  },
];

function dedupeOptions(options: readonly ComboOption[]): ComboOption[] {
  const seen = new Set<string>();
  const result: ComboOption[] = [];
  for (const option of options) {
    const key = option.value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(option);
  }
  return result;
}

function matchesContinuousText(option: ComboOption, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const haystack = `${option.label} ${option.value} ${option.detail ?? ""}`.toLowerCase();
  return trimmed.split(/\s+/).every((token) => haystack.includes(token));
}

function ComboSelect({
  label,
  hint,
  value,
  placeholder,
  options,
  allowEmpty = true,
  theme,
  onSelect,
  onQueryChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  options: readonly ComboOption[];
  allowEmpty?: boolean;
  theme: PluginSurfaceProps["theme"];
  onSelect: (nextValue: string) => void;
  onQueryChange?: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setText(value);
  }, [value]);

  const filtered = useMemo(() => {
    const list = options.filter((option) => matchesContinuousText(option, text));
    return list.slice(0, 12);
  }, [options, text]);

  const trimmed = text.trim();
  const hasExactMatch = options.some((option) => option.value === trimmed);

  return (
    <View style={{ paddingVertical: 10, paddingHorizontal: 14, gap: 6 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            {label}
          </Text>
          {hint ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{hint}</Text>
          ) : null}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ flex: 1 }}>
          <TextInput
            value={text}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            onFocus={() => setOpen(true)}
            onChangeText={(next) => {
              setText(next);
              setOpen(true);
              onQueryChange?.(next);
              if (next.trim() || allowEmpty) {
                onSelect(next.trim());
              }
            }}
            onSubmitEditing={() => {
              if (trimmed || allowEmpty) {
                onSelect(trimmed);
              }
              setOpen(false);
            }}
            style={{
              minHeight: 36,
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface0,
              borderWidth: 1,
              borderColor: open ? theme.colors.accent : theme.colors.border,
              borderRadius: 7,
              paddingHorizontal: 10,
              paddingVertical: 6,
              fontSize: 13,
            }}
          />
        </View>
        {allowEmpty && text ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            onPress={() => {
              setText("");
              onQueryChange?.("");
              onSelect("");
            }}
            style={({ pressed }) => ({
              minHeight: 36,
              minWidth: 32,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: 7,
              backgroundColor: theme.colors.surface0,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "700" }}>
              ×
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Toggle ${label} options`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((prev) => !prev)}
          style={({ pressed }) => ({
            minHeight: 36,
            minWidth: 34,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: open ? theme.colors.accent : theme.colors.border,
            borderRadius: 7,
            backgroundColor: theme.colors.surface0,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
            {open ? "▲" : "▼"}
          </Text>
        </Pressable>
      </View>

      {open ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface0,
            maxHeight: 200,
            overflow: "hidden",
          }}
        >
          <ScrollView nestedScrollEnabled style={{ maxHeight: 200 }}>
            {filtered.map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={`${option.label}:${option.value}`}
                  accessibilityRole="button"
                  onPress={() => {
                    setText(option.value);
                    onQueryChange?.(option.value);
                    onSelect(option.value);
                    setOpen(false);
                  }}
                  style={({ pressed }) => ({
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: theme.colors.border,
                    backgroundColor: selected
                      ? `${theme.colors.accent}22`
                      : pressed
                        ? theme.colors.surface1
                        : "transparent",
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  })}
                >
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text
                      style={{
                        color: selected ? theme.colors.accent : theme.colors.foreground,
                        fontSize: 12,
                        fontWeight: selected ? "700" : "600",
                      }}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                    {option.value && option.value !== option.label ? (
                      <Text
                        style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
                        numberOfLines={1}
                      >
                        {option.value}
                      </Text>
                    ) : null}
                  </View>
                  {option.detail ? (
                    <Text
                      style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
                      numberOfLines={1}
                    >
                      {option.detail}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
            {trimmed && !hasExactMatch ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onSelect(trimmed);
                  setOpen(false);
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  backgroundColor: pressed ? theme.colors.surface1 : "transparent",
                })}
              >
                <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                  Use "{trimmed}"
                </Text>
              </Pressable>
            ) : null}
            {filtered.length === 0 && !trimmed ? (
              <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  No matching options. Type a custom value above.
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function ReadyPrRadarSettings({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const paseo = usePaseo();
  const fetchDirs = useRpc(listLocalDirs);
  const toast = useToast();
  const [dirQueryText, setDirQueryText] = useState(settings.values.sourceCodeDir);
  const [scriptQueryText, setScriptQueryText] = useState(settings.values.routingScriptPath);
  const [error, setError] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ["pr-radar-settings-paseo-config"],
    queryFn: async () => {
      const { config } = await paseo.config.get();
      return config;
    },
    staleTime: 30_000,
  });

  const dirsQuery = useQuery({
    queryKey: ["pr-radar-settings-dirs", settings.values.sourceCodeDir, dirQueryText],
    queryFn: () =>
      fetchDirs({
        sourceCodeDir: settings.values.sourceCodeDir || "~/src",
        query: dirQueryText,
        repository: "",
      }),
    staleTime: 10_000,
  });

  const scriptDirsQuery = useQuery({
    queryKey: ["pr-radar-settings-script-dirs", settings.values.sourceCodeDir, scriptQueryText],
    queryFn: () =>
      fetchDirs({
        sourceCodeDir: settings.values.sourceCodeDir || "~/src",
        query: scriptQueryText,
        repository: "",
      }),
    staleTime: 10_000,
  });

  const profileOptions = useMemo<ComboOption[]>(() => {
    const profiles = configQuery.data?.agentProfiles ?? [];
    return dedupeOptions([
      { label: "Model Router", value: "Model Router", detail: "Default" },
      ...profiles.map((profile) => ({
        label: profile.name,
        value: profile.name,
        detail: [profile.provider, profile.model].filter(Boolean).join("/") || undefined,
      })),
    ]);
  }, [configQuery.data]);

  const providerOptions = useMemo<ComboOption[]>(() => {
    const profiles = configQuery.data?.agentProfiles ?? [];
    const fromProfiles = profiles
      .map((profile) => profile.provider)
      .filter((provider): provider is string => Boolean(provider?.trim()));
    return dedupeOptions([
      { label: "Use profile default", value: "" },
      ...[...fromProfiles, ...KNOWN_PROVIDERS].map((provider) => ({
        label: provider,
        value: provider,
      })),
    ]);
  }, [configQuery.data]);

  const modelOptions = useMemo<ComboOption[]>(() => {
    const profiles = configQuery.data?.agentProfiles ?? [];
    const fromProfiles = profiles
      .map((profile) => profile.model)
      .filter((model): model is string => Boolean(model?.trim()));
    return dedupeOptions([
      { label: "Use provider default", value: "" },
      ...[...fromProfiles, ...KNOWN_MODELS].map((model) => ({
        label: model,
        value: model,
      })),
    ]);
  }, [configQuery.data]);

  const modeOptions = useMemo<ComboOption[]>(() => {
    const profiles = configQuery.data?.agentProfiles ?? [];
    const fromProfiles = profiles
      .map((profile) => profile.modeId)
      .filter((modeId): modeId is string => Boolean(modeId?.trim()));
    return dedupeOptions([
      { label: "Use profile default", value: "" },
      ...[...fromProfiles, ...KNOWN_MODES].map((modeId) => ({
        label: modeId,
        value: modeId,
      })),
    ]);
  }, [configQuery.data]);

  const contextModeOptions = useMemo<ComboOption[]>(() => {
    const profiles = configQuery.data?.agentProfiles ?? [];
    const fromProfiles = profiles
      .map((profile) => {
        const ctx = profile.options?.contextMode;
        return typeof ctx === "string" ? ctx : undefined;
      })
      .filter((ctx): ctx is string => Boolean(ctx?.trim()));
    return dedupeOptions([
      { label: "Use provider default", value: "" },
      ...[...fromProfiles, ...KNOWN_CONTEXT_MODES].map((ctx) => ({
        label: ctx,
        value: ctx,
      })),
    ]);
  }, [configQuery.data]);

  const sourceDirOptions = useMemo<ComboOption[]>(() => {
    const suggestions = dirsQuery.data?.entries ?? [];
    return dedupeOptions([
      { label: "~/src", value: "~/src", detail: "Default" },
      { label: "~/code", value: "~/code" },
      { label: "~/projects", value: "~/projects" },
      ...suggestions.map((dir) => ({
        label: dir.label,
        value: dir.path,
        detail: dir.kind !== "dir" ? dir.kind : undefined,
      })),
    ]);
  }, [dirsQuery.data]);

  const routingScriptOptions = useMemo<ComboOption[]>(() => {
    const suggestions = scriptDirsQuery.data?.entries ?? [];
    return dedupeOptions([
      ...KNOWN_ROUTING_SCRIPTS,
      ...suggestions.map((dir) => ({
        label: dir.label,
        value: dir.path,
      })),
    ]);
  }, [scriptDirsQuery.data]);

  async function savePatch(patch: Partial<typeof settings.values>) {
    setError(null);
    const parsed = PrRadarSettingsSchema.safeParse({ ...settings.values, ...patch });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid setting value.");
      return;
    }
    try {
      await settings.save(parsed.data, settings.revision);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not save settings.");
    }
  }

  async function handleReset() {
    setDirQueryText(DEFAULT_PR_RADAR_SETTINGS.sourceCodeDir);
    setScriptQueryText(DEFAULT_PR_RADAR_SETTINGS.routingScriptPath);
    await savePatch({ ...DEFAULT_PR_RADAR_SETTINGS });
    toast.show("PR Radar settings reset to defaults.", { variant: "success" });
  }

  return (
    <View style={{ gap: 20 }}>
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text>
      ) : null}

      <SettingsSection
        title="Workspace and launch"
        info="Configure where PR Radar looks for or clones repositories and whether Start New Agent prompts or launches immediately."
      >
        <SettingsCard>
          <ComboSelect
            label="Source code directory"
            hint="Default base directory for repositories and auto-clones (default: ~/src)"
            value={settings.values.sourceCodeDir}
            placeholder="~/src"
            options={sourceDirOptions}
            allowEmpty={false}
            theme={theme}
            onQueryChange={setDirQueryText}
            onSelect={(next) => {
              if (next.trim()) void savePatch({ sourceCodeDir: next.trim() });
            }}
          />
          <SettingsSelect
            label="Default workspace mode"
            hint="Start new agents in a dedicated PR worktree or the base checkout"
            value={settings.values.defaultCwdMode}
            options={CWD_MODE_OPTIONS}
            onValueChange={(value) => void savePatch({ defaultCwdMode: value })}
          />
          <SettingsSelect
            label="Auto-launch behavior"
            hint="Choose when Start New Agent opens immediately without showing the chooser"
            value={settings.values.autoLaunchMode}
            options={AUTO_LAUNCH_OPTIONS}
            onValueChange={(value) => void savePatch({ autoLaunchMode: value })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="New agent defaults"
        info="Pre-configure any agent launch settings. Type to filter options continuously or pick from the pull-down list."
      >
        <SettingsCard>
          <ComboSelect
            label="Default profile"
            hint="Paseo agent profile name (default: Model Router)"
            value={settings.values.defaultProfile}
            placeholder="Model Router"
            options={profileOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultProfile: next })}
          />
          <ComboSelect
            label="TUI vendor / provider"
            hint="Optional provider override (e.g. claude, codex, pi)"
            value={settings.values.defaultProvider}
            placeholder="Use profile default"
            options={providerOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultProvider: next })}
          />
          <ComboSelect
            label="Model"
            hint="Optional model ID or version override (e.g. sonnet, gpt-6.1-sol)"
            value={settings.values.defaultModel}
            placeholder="Use provider default"
            options={modelOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultModel: next })}
          />
          <SettingsSelect
            label="Reasoning effort"
            hint="Thinking / reasoning effort level"
            value={settings.values.defaultEffort}
            options={EFFORT_OPTIONS}
            onValueChange={(value) => void savePatch({ defaultEffort: value })}
          />
          <ComboSelect
            label="Permission / mode"
            hint="Optional modeId (e.g. default, bypassPermissions, plan)"
            value={settings.values.defaultModeId}
            placeholder="Use profile default"
            options={modeOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultModeId: next })}
          />
          <ComboSelect
            label="Context mode"
            hint="Optional contextMode option passed to the provider"
            value={settings.values.defaultContextMode}
            placeholder="Use provider default"
            options={contextModeOptions}
            theme={theme}
            onSelect={(next) => void savePatch({ defaultContextMode: next })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Routing script"
        info="Optional executable script that receives PR, repo, and workspace JSON on stdin and returns provider, model, effort, and mode JSON."
      >
        <SettingsCard>
          <ComboSelect
            label="Routing script path"
            hint="Leave empty to use static defaults above (example: examples/pr-radar-route.py)"
            value={settings.values.routingScriptPath}
            placeholder="~/src/paseo-plugins-omercnet/pr-radar/examples/pr-radar-route.py"
            options={routingScriptOptions}
            theme={theme}
            onQueryChange={setScriptQueryText}
            onSelect={(next) => void savePatch({ routingScriptPath: next })}
          />
          <SettingsAction
            label="Reset settings"
            hint="Restore all PR Radar settings to their defaults"
            actionLabel="Reset defaults"
            onPress={() => void handleReset()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

export function PrRadarSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(prRadarSettings);
  if (settings.status === "loading") return <Loading />;
  if (settings.status === "error" || settings.status === "invalid") {
    return <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>;
  }
  return <ReadyPrRadarSettings settings={settings} theme={theme} />;
}
