import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

export interface ComboOption {
  label: string;
  value: string;
  detail?: string;
}

export const EFFORT_OPTIONS: readonly ComboOption[] = [
  { label: "Profile / provider default", value: "" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high (xhigh)", value: "xhigh" },
];

export const KNOWN_PROVIDERS: readonly string[] = [
  "claude",
  "codex",
  "pi",
  "antigravity",
  "gemini",
  "hermes",
  "cursor",
];

export const KNOWN_MODELS: readonly string[] = [
  "sonnet",
  "opus",
  "haiku",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-5.4",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

export const KNOWN_MODES: readonly string[] = [
  "default",
  "bypassPermissions",
  "plan",
  "acceptEdits",
  "dontAsk",
  "auto",
];

export const KNOWN_CONTEXT_MODES: readonly string[] = ["full", "compact", "minimal", "none"];

export function dedupeOptions(options: readonly ComboOption[]): ComboOption[] {
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

export function ComboSelect({
  label,
  hint,
  value,
  placeholder,
  options,
  allowEmpty = true,
  compact = false,
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
  compact?: boolean;
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
    <View style={compact ? { gap: 4 } : { paddingVertical: 10, paddingHorizontal: 14, gap: 6 }}>
      {compact ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      ) : (
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
      )}

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
              minHeight: compact ? 34 : 36,
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface0,
              borderWidth: 1,
              borderColor: open ? theme.colors.accent : theme.colors.border,
              borderRadius: compact ? 8 : 7,
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
              minHeight: compact ? 34 : 36,
              minWidth: compact ? 30 : 32,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: compact ? 8 : 7,
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
            minHeight: compact ? 34 : 36,
            minWidth: compact ? 32 : 34,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: open ? theme.colors.accent : theme.colors.border,
            borderRadius: compact ? 8 : 7,
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

export function useAgentLaunchOptions(enabled = true) {
  const paseo = usePaseo();

  const configQuery = useQuery({
    queryKey: ["pr-radar-paseo-config"],
    queryFn: async () => {
      const { config } = await paseo.config.get();
      return config;
    },
    enabled,
    staleTime: 30_000,
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

  return {
    profileOptions,
    providerOptions,
    modelOptions,
    modeOptions,
    contextModeOptions,
    effortOptions: EFFORT_OPTIONS,
  };
}
