import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Text, type TextStyle, View, type ViewStyle } from "react-native";
import { createComposeSession } from "./browser-compose-session";
import { ControlButton, type ControlButtonStyles } from "./browser-control-button";

type Theme = PluginWorkspacePanelProps["theme"];
interface ComposeStyles extends ControlButtonStyles {
  sheetContent: ViewStyle;
  devicePresetDetail: TextStyle;
  field: TextStyle;
  mobileRow: ViewStyle;
}

/** Visible draft sheet; text is inserted into the focused page field only by an explicit Done. */
export function ComposeTextControls({
  styles,
  theme,
  composeText,
  cancelInput,
  enabled,
  ownershipKey,
  request,
  onRequestHandled,
}: {
  styles: ComposeStyles;
  theme: Theme;
  composeText(text: string): boolean;
  cancelInput(): void;
  enabled: boolean;
  ownershipKey: string;
  request: { id: number; ownershipKey: string } | null;
  onRequestHandled(id: number): void;
}) {
  const handledRequest = useRef<number | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  // The input is host-owned (uncontrolled): echoing every character back through
  // React state let a fast second keystroke be overwritten by a stale value.
  // Latest text is kept here; state changes only when emptiness flips or the draft resets.
  const text = useRef("");
  const generation = useRef(0);
  const [hasText, setHasText] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const draftGeneration = generation.current;
  const resetDraft = () => {
    generation.current += 1;
    text.current = "";
    setHasText(false);
    setInputKey(generation.current);
  };
  const live = useRef({ enabled, ownershipKey, composeText, cancelInput });
  live.current = { enabled, ownershipKey, composeText, cancelInput };
  const [session] = useState(() =>
    createComposeSession({
      authority: () => live.current,
      composeText: (text) => live.current.composeText(text),
      cancelInput: () => live.current.cancelInput(),
    }),
  );
  const canCommit = enabled && session.owner() === ownershipKey;
  const closeCompose = () => {
    setComposeOpen(false);
    resetDraft();
    session.close();
  };
  const openCompose = () => {
    resetDraft();
    session.open();
    setComposeOpen(true);
  };
  // Callbacks are fenced to the draft that rendered them: a retained Done/Cancel
  // from a closed draft must not publish, or close, a same-owner replacement.
  const commit = () => {
    if (generation.current !== draftGeneration) return;
    if (session.commit(text.current) && generation.current === draftGeneration) closeCompose();
  };
  const dismiss = () => {
    if (generation.current === draftGeneration) closeCompose();
  };
  useEffect(() => {
    if (!request || handledRequest.current === request.id) return;
    handledRequest.current = request.id;
    if (enabled && request.ownershipKey === ownershipKey) openCompose();
    onRequestHandled(request.id);
  }, [request, enabled, ownershipKey, onRequestHandled]);
  return (
    <Modal
      title="Compose text"
      open={composeOpen}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <Modal.Content>
        <View style={styles.sheetContent}>
          <Text style={styles.devicePresetDetail}>
            Compose with your keyboard, then choose Done to insert the text into the focused page
            field.
          </Text>
          <TextInput
            autoFocus
            multiline
            key={inputKey}
            defaultValue=""
            maxLength={16_000}
            accessibilityLabel="Text to compose"
            onChangeText={(next) => {
              // A callback retained from a closed or replaced draft must not write into the new one.
              if (generation.current !== draftGeneration) return;
              text.current = next;
              setHasText(next.length > 0);
            }}
            style={[styles.field, { minHeight: 100 }]}
          />
          {!canCommit ? (
            <Text style={styles.devicePresetDetail}>
              Browser control or page changed. Close this draft and focus the field again.
            </Text>
          ) : null}
          <View style={styles.mobileRow}>
            <ControlButton styles={styles} theme={theme} label="Cancel" onPress={dismiss} />
            <ControlButton
              styles={styles}
              theme={theme}
              label="Done"
              primary
              disabled={!canCommit || !hasText}
              onPress={commit}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
