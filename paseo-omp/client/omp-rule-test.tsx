import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  MAX_RULE_TEST_CHARS,
  type OmpRuleTestSource,
  OmpRuleTestSourceSchema,
  testOmpRules,
} from "../shared/omp-rules";
import type { OmpStore } from "../shared/omp-store";
import { describe } from "./omp-accounts-section";
import type { OmpConfigStyles } from "./omp-config-styles";
import { Choice } from "./omp-tool-config-section";

type Theme = PluginSurfaceProps["theme"];

const SOURCES = OmpRuleTestSourceSchema.options;

export function OmpRuleTest({
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
  const test = useRpc(testOmpRules);
  const [snippet, setSnippet] = useState("");
  const [path, setPath] = useState("");
  const [source, setSource] = useState<OmpRuleTestSource | null>(null);
  const run = useMutation({
    mutationFn: () =>
      test({
        store,
        ...(cwd ? { cwd } : {}),
        snippet,
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(source ? { source } : {}),
      }),
  });
  const result = run.data;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Test a snippet</Text>
      </View>
      <View style={styles.setting}>
        <Text style={styles.settingDescription}>
          Paste text to see which rules would fire on it, in this {cwd ? "workspace" : "user"}{" "}
          scope. Nothing is sent to a model.
        </Text>
        <TextInput
          accessibilityLabel="Snippet to test"
          multiline
          maxLength={MAX_RULE_TEST_CHARS}
          placeholder="Text the agent might write"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={snippet}
          onChangeText={setSnippet}
          style={[styles.scalarInput, { minHeight: 120, maxWidth: undefined }]}
        />
        <TextInput
          accessibilityLabel="File path of the snippet"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="File path, optional (src/app.ts)"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={path}
          onChangeText={setPath}
          style={[styles.scalarInput, { maxWidth: undefined }]}
        />
        <View style={styles.editorActions}>
          <Choice
            styles={styles}
            label="Auto"
            selected={!source}
            onPress={() => setSource(null)}
          />
          {SOURCES.map((option) => (
            <Choice
              key={option}
              styles={styles}
              label={option}
              selected={source === option}
              onPress={() => setSource(option)}
            />
          ))}
        </View>
        <View style={styles.editorActions}>
          <Choice
            styles={styles}
            label={run.isPending ? "Testing..." : "Test"}
            selected
            disabled={snippet.trim() === "" || run.isPending}
            onPress={() => run.mutate()}
          />
        </View>
        {run.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {describe(run.error)}
          </Text>
        ) : null}
        {result?.status === "error" ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {result.message}
          </Text>
        ) : null}
        {result?.status === "ready" ? (
          <>
            <Text style={styles.muted}>
              {result.triggered.length === 0
                ? `No rule fired, out of ${result.evaluated} checked`
                : `${result.triggered.length} of ${result.evaluated} rules fired`}
            </Text>
            {result.triggered.map((hit) => (
              <View key={hit.name} style={styles.setting}>
                <Text selectable style={styles.settingValue}>
                  {hit.name}
                </Text>
                {hit.regex.length > 0 ? (
                  <Text selectable style={styles.settingDescription}>
                    Text matched: {hit.regex.join(", ")}
                  </Text>
                ) : null}
                {hit.ast.length > 0 ? (
                  <Text selectable style={styles.settingDescription}>
                    Code matched: {hit.ast.join(", ")}
                  </Text>
                ) : null}
                <Text selectable style={styles.settingPath}>
                  {hit.path}
                </Text>
              </View>
            ))}
          </>
        ) : null}
      </View>
    </View>
  );
}
