import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type PluginClientContext,
  type PluginComposerPillProps,
  type PluginWorkspacePanelProps,
  useRpc,
} from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  DEVICE_PRESETS,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  captureBrowserRpc,
  detachBrowserRpc,
  listOpenBrowserWorkspacesRpc,
  navigateBrowserRpc,
  releaseControlRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserState,
  type DevicePresetId,
} from "../shared/browser";

const SPACE = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
} as const;
const RADIUS = { sm: 6, md: 8, lg: 10 } as const;
const TYPE = { caption: 11, body: 13, title: 14 } as const;
const DIMENSION = {
  control: 34,
  touch: 44,
  pad: 60,
  icon: 15,
  addressCompact: 120,
  addressRegular: 220,
  canvasCompact: 220,
  canvasRegular: 320,
  helperMax: 420,
  viewportField: 72,
  typeField: 180,
  screenRadius: 20,
} as const;
const DRAG_THRESHOLD = 6;
const SCROLL_STEP = 520;
const CAPTURE_INTERVAL_READY = 250;
const CAPTURE_INTERVAL_WAITING = 1_500;
const MAX_VIEWER_LABEL_LENGTH = 64;
const PILL_PRESENCE_POLL_MS = 2_000;
const MAX_URL_LENGTH = 8_192;
const MAX_TEXT_LENGTH = 4_000;
const BYTES_PER_KIBIBYTE = 1_024;
const MAX_SCROLL_DELTA = 4_000;

type Theme = PluginWorkspacePanelProps["theme"];
type InteractionMode = "click" | "double" | "right";
type SwipeMode = "scroll" | "drag";
type SpecialKey = Extract<BrowserInputEvent, { kind: "key" }>["key"];

interface Size {
  width: number;
  height: number;
}

interface DisplayRect extends Size {
  x: number;
  y: number;
}

interface DisplayPoint extends Size {
  x: number;
  y: number;
}

const SPECIAL_KEYS: readonly { key: SpecialKey; label: string }[] = [
  { key: "Enter", label: "Enter" },
  { key: "Tab", label: "Tab" },
  { key: "Escape", label: "Esc" },
  { key: "Backspace", label: "Backspace" },
  { key: "Delete", label: "Delete" },
  { key: "ArrowUp", label: "↑" },
  { key: "ArrowDown", label: "↓" },
  { key: "ArrowLeft", label: "←" },
  { key: "ArrowRight", label: "→" },
  { key: "Home", label: "Home" },
  { key: "End", label: "End" },
  { key: "PageUp", label: "Page up" },
  { key: "PageDown", label: "Page down" },
  { key: "Space", label: "Space" },
];

function containedRect(container: Size, image: Size): DisplayRect | null {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null;
  }
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The shared browser request failed.";
}

function isFrameCurrent(frame: BrowserFrame, state: BrowserState): boolean {
  return (
    frame.sessionId === state.sessionId &&
    frame.navigationGeneration === state.navigationGeneration &&
    frame.viewportGeneration === state.viewportGeneration
  );
}

function clampScrollDelta(delta: number): number {
  return Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, Math.round(delta)));
}

function createStyles(theme: Theme, compact: boolean) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      minHeight: 0,
      backgroundColor: theme.colors.surface0,
    },
    statusRow: {
      minHeight: 30,
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xxs,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: SPACE.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    statusSummary: {
      minWidth: 0,
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: SPACE.sm,
    },
    statusDot: {
      width: SPACE.sm,
      height: SPACE.sm,
      borderRadius: RADIUS.sm,
    },
    statusText: {
      color: theme.colors.foreground,
      fontSize: TYPE.body,
      fontWeight: "600",
    },
    mutedText: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
    },
    controllerText: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
      flexShrink: 1,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    chrome: {
      minHeight: 40,
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xs,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    addressRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    addressInput: {
      flex: 1,
      minWidth: compact ? DIMENSION.addressCompact : DIMENSION.addressRegular,
    },
    chromeAddressInput: {
      height: 28,
      borderRadius: RADIUS.md,
      backgroundColor: theme.colors.surface1,
    },
    chromeIconButton: {
      width: 28,
      height: 28,
      borderRadius: RADIUS.md,
      alignItems: "center",
      justifyContent: "center",
    },
    chromeIconButtonHovered: {
      backgroundColor: theme.colors.surface2,
    },
    chromeIconButtonPressed: {
      opacity: 0.72,
    },
    chromeIconButtonDisabled: {
      opacity: 0.45,
    },
    toolbarContent: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    button: {
      minHeight: DIMENSION.control,
      minWidth: DIMENSION.control,
      paddingHorizontal: SPACE.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: RADIUS.sm,
      backgroundColor: theme.colors.surface2,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: SPACE.xs,
    },
    buttonSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    buttonPrimary: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    buttonDanger: {
      borderColor: theme.colors.statusWarning,
    },
    buttonHovered: {
      borderColor: theme.colors.foregroundMuted,
    },
    buttonPressed: {
      opacity: 0.72,
    },
    buttonFocused: {
      borderColor: theme.colors.accent,
      borderWidth: 2,
    },
    buttonDisabled: {
      opacity: 0.42,
    },
    buttonText: {
      color: theme.colors.foreground,
      fontSize: TYPE.caption,
      fontWeight: "600",
    },
    buttonTextSelected: {
      color: theme.colors.accentForeground,
    },
    field: {
      height: DIMENSION.control,
      paddingHorizontal: SPACE.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: RADIUS.sm,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      fontSize: TYPE.body,
    },
    fieldFocused: {
      borderColor: theme.colors.accent,
      borderWidth: 2,
    },
    fieldDisabled: {
      opacity: 0.5,
    },
    errorRow: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xs,
      borderLeftWidth: SPACE.xs,
      borderLeftColor: theme.colors.statusDanger,
      backgroundColor: theme.colors.surface1,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    errorText: {
      flex: 1,
      color: theme.colors.statusDanger,
      fontSize: TYPE.caption,
    },
    canvasShell: {
      flex: 1,
      minHeight: compact ? DIMENSION.canvasCompact : DIMENSION.canvasRegular,
      minWidth: 0,
      margin: compact ? SPACE.sm : 0,
      borderRadius: compact ? DIMENSION.screenRadius : 0,
      overflow: "hidden",
      backgroundColor: theme.colors.surface1,
    },
    canvas: {
      flex: 1,
      minHeight: 0,
      overflow: "hidden",
    },
    frame: {
      position: "absolute",
      borderRadius: compact ? DIMENSION.screenRadius - SPACE.xs : 0,
    },
    interactionLayer: {
      position: "absolute",
    },
    canvasState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: SPACE.lg,
      gap: SPACE.sm,
    },
    canvasTitle: {
      color: theme.colors.foreground,
      fontSize: TYPE.title,
      fontWeight: "600",
      textAlign: "center",
    },
    canvasDetail: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
      textAlign: "center",
      maxWidth: DIMENSION.helperMax,
    },
    canvasFooter: {
      minHeight: DIMENSION.control,
      paddingHorizontal: SPACE.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: SPACE.sm,
      backgroundColor: theme.colors.surface1,
    },
    canvasFooterText: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
      flexShrink: 1,
    },
    controls: {
      paddingHorizontal: compact ? SPACE.md : SPACE.sm,
      paddingTop: compact ? SPACE.md : SPACE.sm,
      paddingBottom: compact ? SPACE.lg : SPACE.sm,
      gap: compact ? SPACE.sm : SPACE.xs,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    mobileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    sheetContent: {
      gap: SPACE.md,
      padding: SPACE.sm,
    },
    sheetGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: SPACE.sm,
    },
    sheetPad: {
      alignItems: "center",
      gap: SPACE.sm,
    },
    sheetPadRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: SPACE.sm,
    },
    padSpacer: {
      width: DIMENSION.pad,
    },
    controlStrip: {
      minHeight: DIMENSION.control,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    stripLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
      fontWeight: "600",
      marginRight: SPACE.xs,
    },
    separator: {
      width: 1,
      alignSelf: "stretch",
      marginVertical: SPACE.xs,
      marginHorizontal: SPACE.xs,
      backgroundColor: theme.colors.border,
    },
    viewportField: {
      width: DIMENSION.viewportField,
      textAlign: "center",
    },
    multiply: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.body,
    },
    typeRow: {
      flexDirection: compact ? "column" : "row",
      gap: SPACE.xs,
    },
    typeInput: {
      flex: 1,
      minWidth: compact ? undefined : DIMENSION.typeField,
    },
    keysContent: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
      paddingTop: SPACE.xs,
    },
    deviceModalContent: {
      gap: SPACE.sm,
      padding: SPACE.sm,
    },
    devicePresetRow: {
      minHeight: 46,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: RADIUS.md,
      backgroundColor: theme.colors.surface1,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    devicePresetRowSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface2,
    },
    devicePresetText: {
      flex: 1,
      color: theme.colors.foreground,
      fontSize: TYPE.body,
      fontWeight: "600",
    },
    devicePresetDetail: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
    },
    customViewportRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    buttonLarge: {
      minHeight: DIMENSION.touch,
      paddingHorizontal: SPACE.md,
      borderRadius: RADIUS.md,
    },
    buttonFill: {
      flex: 1,
    },
    buttonPad: {
      width: DIMENSION.pad,
      minHeight: DIMENSION.touch,
    },
  });
}

interface ControlButtonStyles {
  button: ViewStyle;
  buttonSelected: ViewStyle;
  buttonPrimary: ViewStyle;
  buttonDanger: ViewStyle;
  buttonHovered: ViewStyle;
  buttonPressed: ViewStyle;
  buttonFocused: ViewStyle;
  buttonDisabled: ViewStyle;
  buttonLarge: ViewStyle;
  buttonFill: ViewStyle;
  buttonPad: ViewStyle;
  buttonText: TextStyle;
  buttonTextSelected: TextStyle;
}

interface FieldStyles {
  field: TextStyle;
  fieldFocused: TextStyle;
  fieldDisabled: TextStyle;
}

interface ErrorNoticeStyles extends ControlButtonStyles {
  errorRow: ViewStyle;
  errorText: TextStyle;
}

interface CanvasPlaceholderStyles {
  canvasState: ViewStyle;
  canvasTitle: TextStyle;
  canvasDetail: TextStyle;
}

interface ControlButtonProps {
  styles: ControlButtonStyles;
  theme: Theme;
  label: string;
  accessibilityLabel?: string;
  icon?: string;
  selected?: boolean;
  primary?: boolean;
  danger?: boolean;
  large?: boolean;
  fill?: boolean;
  pad?: boolean;
  disabled?: boolean;
  onPress(): void;
}

function ControlButton({
  styles,
  theme,
  label,
  accessibilityLabel,
  icon,
  selected = false,
  primary = false,
  danger = false,
  large = false,
  fill = false,
  pad = false,
  disabled = false,
  onPress,
}: ControlButtonProps) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const highlighted = selected || primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        selected ? styles.buttonSelected : null,
        primary ? styles.buttonPrimary : null,
        danger ? styles.buttonDanger : null,
        hovered && !highlighted ? styles.buttonHovered : null,
        pressed ? styles.buttonPressed : null,
        focused ? styles.buttonFocused : null,
        disabled ? styles.buttonDisabled : null,
        large || pad ? styles.buttonLarge : null,
        fill ? styles.buttonFill : null,
        pad ? styles.buttonPad : null,
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={DIMENSION.icon}
          color={highlighted ? theme.colors.accentForeground : theme.colors.foregroundMuted}
        />
      ) : null}
      <Text style={[styles.buttonText, highlighted ? styles.buttonTextSelected : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

interface ChromeIconButtonStyles {
  chromeIconButton: ViewStyle;
  chromeIconButtonHovered: ViewStyle;
  chromeIconButtonPressed: ViewStyle;
  chromeIconButtonDisabled: ViewStyle;
}

function ChromeIconButton({
  styles,
  theme,
  label,
  icon,
  selected = false,
  disabled = false,
  onPress,
}: {
  styles: ChromeIconButtonStyles;
  theme: Theme;
  label: string;
  icon: string;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chromeIconButton,
        hovered ? styles.chromeIconButtonHovered : null,
        pressed ? styles.chromeIconButtonPressed : null,
        disabled ? styles.chromeIconButtonDisabled : null,
      ]}
    >
      <Icon
        name={icon}
        size={16}
        color={selected ? theme.colors.accent : theme.colors.foregroundMuted}
      />
    </Pressable>
  );
}

interface FieldProps {
  styles: FieldStyles;
  theme: Theme;
  value: string;
  accessibilityLabel: string;
  placeholder?: string;
  editable?: boolean;
  maxLength?: number;
  keyboardType?: TextInputProps["keyboardType"];
  inputMode?: TextInputProps["inputMode"];
  returnKeyType?: TextInputProps["returnKeyType"];
  selectTextOnFocus?: boolean;
  style?: StyleProp<TextStyle>;
  onChangeText(value: string): void;
  onSubmit?(): void;
  onFocus?(): void;
  onBlur?(): void;
}

function Field({
  styles,
  theme,
  value,
  accessibilityLabel,
  placeholder,
  editable = true,
  maxLength,
  keyboardType,
  inputMode,
  returnKeyType,
  selectTextOnFocus,
  style,
  onChangeText,
  onSubmit,
  onFocus,
  onBlur,
}: FieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      editable={editable}
      keyboardType={keyboardType}
      inputMode={inputMode}
      maxLength={maxLength}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      onChangeText={onChangeText}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onSubmitEditing={onSubmit}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      returnKeyType={returnKeyType}
      selectionColor={theme.colors.accent}
      selectTextOnFocus={selectTextOnFocus}
      style={[
        styles.field,
        style,
        focused ? styles.fieldFocused : null,
        !editable ? styles.fieldDisabled : null,
      ]}
      value={value}
    />
  );
}

function ErrorNotice({
  styles,
  theme,
  message,
  action,
  onAction,
  actionDisabled = false,
}: {
  styles: ErrorNoticeStyles;
  theme: Theme;
  message: string;
  action?: string | undefined;
  onAction?: (() => void) | undefined;
  actionDisabled?: boolean;
}) {
  return (
    <View accessibilityRole="alert" style={styles.errorRow}>
      <Icon name="CircleAlert" size={DIMENSION.icon} color={theme.colors.statusDanger} />
      <Text style={styles.errorText}>{message}</Text>
      {action && onAction ? (
        <ControlButton
          styles={styles}
          theme={theme}
          label={action}
          disabled={actionDisabled}
          onPress={onAction}
        />
      ) : null}
    </View>
  );
}

function CanvasPlaceholder({
  styles,
  theme,
  title,
  detail,
  loading = false,
}: {
  styles: CanvasPlaceholderStyles;
  theme: Theme;
  title: string;
  detail: string;
  loading?: boolean;
}) {
  return (
    <View style={styles.canvasState}>
      {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
      <Text style={styles.canvasTitle}>{title}</Text>
      <Text style={styles.canvasDetail}>{detail}</Text>
    </View>
  );
}

function SharedBrowserPill({ theme }: PluginComposerPillProps) {
  const labelStyle = useMemo(
    () => ({ color: theme.colors.foregroundMuted, flexShrink: 1 }),
    [theme],
  );
  return (
    <>
      <Icon name="PanelsTopLeft" size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={labelStyle}>
        Shared Browser
      </Text>
    </>
  );
}

export function contributeSharedBrowserClient(client: PluginClientContext) {
  const agents = new Map<string, { id: string; workspaceId: string }>();
  const pills = new Map<string, { workspaceId: string; dispose: () => void }>();
  let openWorkspaceIds = new Set<string>();
  let refreshing = false;
  let stopped = false;

  const removePill = (agentId: string) => {
    pills.get(agentId)?.dispose();
    pills.delete(agentId);
  };
  const syncPill = (agent: { id: string; workspaceId: string }) => {
    const current = pills.get(agent.id);
    if (!openWorkspaceIds.has(agent.workspaceId)) {
      removePill(agent.id);
      return;
    }
    if (current?.workspaceId === agent.workspaceId) return;
    removePill(agent.id);
    const workspaceId = agent.workspaceId;
    pills.set(agent.id, {
      workspaceId,
      dispose: client.addComposerPill({
        id: "open-shared-browser",
        title: "Open Shared Browser",
        workspaceId,
        agentId: agent.id,
        Component: SharedBrowserPill,
        onPress() {
          client.openPanel("shared-browser", { workspaceId });
        },
      }),
    });
  };
  const syncAllPills = () => {
    for (const agent of agents.values()) syncPill(agent);
  };
  const refreshPresence = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const result = await client.rpc(listOpenBrowserWorkspacesRpc, {});
      if (stopped) return;
      openWorkspaceIds = new Set(result.workspaceIds);
      syncAllPills();
    } catch {
      return;
    } finally {
      refreshing = false;
    }
  };

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      agents.delete(update.agentId);
      removePill(update.agentId);
      return;
    }
    const { id, workspaceId } = update.agent;
    if (!workspaceId) {
      agents.delete(id);
      removePill(id);
      return;
    }
    const agent = { id, workspaceId };
    agents.set(id, agent);
    syncPill(agent);
    void refreshPresence();
  });
  void client.paseo.agents
    .list()
    .then(async ({ entries }) => {
      for (const { agent } of entries) {
        if (agent.workspaceId)
          agents.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId });
      }
      await refreshPresence();
    })
    .catch(() => undefined);
  const presenceTimer = setInterval(() => void refreshPresence(), PILL_PRESENCE_POLL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(presenceTimer);
    unsubscribe();
    for (const { dispose } of pills.values()) dispose();
    pills.clear();
    agents.clear();
  };
}
export function SharedBrowserPanel({
  theme,
  host,
  layout,
  workspaceId,
}: PluginWorkspacePanelProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const viewerLabel = useState(() =>
    `Paseo ${layout.platform} · ${host.label} · ${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`.slice(0, MAX_VIEWER_LABEL_LENGTH),
  )[0];

  const attachBrowser = useRpc(attachBrowserRpc);
  const detachBrowser = useRpc(detachBrowserRpc);
  const captureBrowser = useRpc(captureBrowserRpc);
  const acquireControl = useRpc(acquireControlRpc);
  const releaseControl = useRpc(releaseControlRpc);
  const navigateBrowser = useRpc(navigateBrowserRpc);
  const resizeBrowser = useRpc(resizeBrowserRpc);
  const applyDevicePreset = useRpc(applyDevicePresetRpc);
  const sendBrowserInput = useRpc(sendBrowserInputRpc);

  const mountedRef = useRef(false);
  const activeViewerTokenRef = useRef<string | null>(null);
  const stateRef = useRef<BrowserState | null>(null);
  const frameRef = useRef<BrowserFrame | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const mutationEpochRef = useRef(0);
  const captureInFlightRef = useRef(false);

  const [state, setState] = useState<BrowserState | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [controlToken, setControlToken] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [viewportWidth, setViewportWidth] = useState("");
  const [viewportHeight, setViewportHeight] = useState("");
  const [typeDraft, setTypeDraft] = useState("");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("click");
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const [pointerSheetOpen, setPointerSheetOpen] = useState(false);
  const [keysSheetOpen, setKeysSheetOpen] = useState(false);
  const [swipeMode, setSwipeMode] = useState<SwipeMode>(layout.compact ? "scroll" : "drag");
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const acceptState = useCallback((next: BrowserState) => {
    const previous = stateRef.current;
    if (
      previous?.sessionId === next.sessionId &&
      (next.navigationGeneration < previous.navigationGeneration ||
        next.viewportGeneration < previous.viewportGeneration)
    ) {
      return false;
    }
    const currentFrame = frameRef.current;
    if (previous && previous.sessionId !== next.sessionId) {
      setControlToken(null);
    }
    if (currentFrame && !isFrameCurrent(currentFrame, next)) {
      frameRef.current = null;
      setFrame(null);
      lastPointRef.current = null;
    }
    stateRef.current = next;
    setState(next);
    return true;
  }, []);

  const attachQuery = useQuery({
    queryKey: ["shared-browser", "attach", workspaceId, viewerLabel],
    queryFn: async () => {
      const result = await attachBrowser({ workspaceId, viewerLabel });
      if (!mountedRef.current) {
        await detachBrowser({ viewerToken: result.viewerToken }).catch(() => undefined);
        throw new Error("The browser panel closed before attachment completed.");
      }
      return result;
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const viewerToken = reconnecting ? null : (attachQuery.data?.viewerToken ?? null);

  useEffect(() => {
    if (!viewerToken) return;
    activeViewerTokenRef.current = viewerToken;
    return () => {
      if (activeViewerTokenRef.current === viewerToken) activeViewerTokenRef.current = null;
      void detachBrowser({ viewerToken }).catch(() => undefined);
    };
  }, [detachBrowser, viewerToken]);

  useEffect(() => {
    if (!reconnecting && attachQuery.data) acceptState(attachQuery.data.state);
  }, [acceptState, attachQuery.data, reconnecting]);

  useEffect(() => {
    stateRef.current = null;
    frameRef.current = null;
    setState(null);
    setFrame(null);
    setControlToken(null);
    setOperationError(null);
  }, [workspaceId]);

  const captureQuery = useQuery({
    queryKey: ["shared-browser", "capture", viewerToken],
    queryFn: async () => {
      if (!viewerToken) throw new Error("The browser viewer is not attached.");
      const mutationEpoch = mutationEpochRef.current;
      const knownFrame = frameRef.current;
      captureInFlightRef.current = true;
      try {
        const result = await captureBrowser({
          viewerToken,
          quality: "medium",
          knownFrameId: knownFrame?.frameId ?? null,
        });
        return { ...result, mutationEpoch };
      } finally {
        captureInFlightRef.current = false;
      }
    },
    enabled: Boolean(viewerToken),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state.status === "ready"
        ? CAPTURE_INTERVAL_READY
        : CAPTURE_INTERVAL_WAITING,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  useEffect(() => {
    const result = captureQuery.data;
    if (
      !result ||
      result.mutationEpoch !== mutationEpochRef.current ||
      !acceptState(result.state)
    ) {
      return;
    }
    if (result.frame && isFrameCurrent(result.frame, result.state)) {
      frameRef.current = result.frame;
      setImageError(false);
      setFrame(result.frame);
    }
  }, [acceptState, captureQuery.data]);

  useEffect(() => {
    if (state?.controller !== "self" && controlToken) setControlToken(null);
  }, [controlToken, state?.controller, state?.sessionId]);

  useEffect(() => {
    if (!state || addressFocused) return;
    setAddressDraft(state.url);
  }, [addressFocused, state?.sessionId, state?.url]);

  useEffect(() => {
    if (!state) return;
    setViewportWidth(String(state.viewport.width));
    setViewportHeight(String(state.viewport.height));
  }, [state?.sessionId, state?.viewport.height, state?.viewport.width]);

  useEffect(() => {
    setImageError(false);
  }, [frame?.frameId]);

  const refreshCapture = useCallback(() => {
    const requestWasInFlight = captureInFlightRef.current;
    const request = captureQuery.refetch({ cancelRefetch: false });
    if (requestWasInFlight) {
      void request.then(() => captureQuery.refetch({ cancelRefetch: false }));
    }
  }, [captureQuery.refetch]);

  const mutationFailed = useCallback(
    (error: unknown) => {
      setOperationError(`${errorMessage(error)} State refreshed; the action was not replayed.`);
      refreshCapture();
    },
    [refreshCapture],
  );

  const mutationSucceeded = useCallback(
    (next: BrowserState) => {
      setOperationError(null);
      acceptState(next);
      refreshCapture();
    },
    [acceptState, refreshCapture],
  );

  const acquireMutation = useMutation({
    mutationFn: acquireControl,
    retry: false,
    onSuccess: (result) => {
      setControlToken(result.controlToken);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const releaseMutation = useMutation({
    mutationFn: releaseControl,
    retry: false,
    onSuccess: (result) => {
      setControlToken(null);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const navigateMutation = useMutation({
    mutationFn: navigateBrowser,
    retry: false,
    onSuccess: (result) => mutationSucceeded(result.state),
    onError: mutationFailed,
  });
  const resizeMutation = useMutation({
    mutationFn: resizeBrowser,
    retry: false,
    onSuccess: (result) => mutationSucceeded(result.state),
    onError: mutationFailed,
  });
  const deviceMutation = useMutation({
    mutationFn: applyDevicePreset,
    retry: false,
    onSuccess: (result) => mutationSucceeded(result.state),
    onError: mutationFailed,
  });
  const inputMutation = useMutation({
    mutationFn: sendBrowserInput,
    retry: false,
    onSuccess: (result, variables) => {
      if (variables.event.kind === "type") {
        const sentText = variables.event.text;
        setTypeDraft((current) => (current === sentText ? "" : current));
      }
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });

  const anyMutationPending =
    acquireMutation.isPending ||
    releaseMutation.isPending ||
    navigateMutation.isPending ||
    resizeMutation.isPending ||
    deviceMutation.isPending ||
    inputMutation.isPending;
  const canControl = Boolean(viewerToken && controlToken && state?.controller === "self");
  const currentFrame = frame && state && isFrameCurrent(frame, state) ? frame : null;
  const canSendInput = canControl && Boolean(currentFrame) && !inputMutation.isPending;

  const displayRect = useMemo(
    () =>
      currentFrame
        ? containedRect(containerSize, { width: currentFrame.width, height: currentFrame.height })
        : null,
    [containerSize, currentFrame],
  );
  const frameUri = useMemo(
    () => (currentFrame ? `data:${currentFrame.mimeType};base64,${currentFrame.dataBase64}` : null),
    [currentFrame],
  );

  const controlContext = useCallback(() => {
    const viewer = activeViewerTokenRef.current;
    const current = stateRef.current;
    if (!viewer || !controlToken || !current || current.controller !== "self") return null;
    return {
      viewerToken: viewer,
      controlToken,
      expected: {
        sessionId: current.sessionId,
        navigationGeneration: current.navigationGeneration,
        viewportGeneration: current.viewportGeneration,
      },
    };
  }, [controlToken]);

  const inputContext = useCallback(() => {
    const context = controlContext();
    const current = stateRef.current;
    const targetFrame = frameRef.current;
    if (!context || !current || !targetFrame || !isFrameCurrent(targetFrame, current)) return null;
    return {
      ...context,
      target: {
        frameId: targetFrame.frameId,
        navigationGeneration: targetFrame.navigationGeneration,
        viewportGeneration: targetFrame.viewportGeneration,
      },
    };
  }, [controlContext]);

  const requireControlContext = useCallback(() => {
    const context = controlContext();
    if (!context) {
      setOperationError("Take control before changing the browser.");
      return null;
    }
    return context;
  }, [controlContext]);

  const requireInputContext = useCallback(() => {
    const context = inputContext();
    if (!context) {
      setOperationError("A current frame and active control lease are required for browser input.");
      refreshCapture();
      return null;
    }
    return context;
  }, [inputContext, refreshCapture]);

  const sendEvent = useCallback(
    (event: BrowserInputEvent) => {
      const context = requireInputContext();
      if (!context || inputMutation.isPending) return;
      mutationEpochRef.current += 1;
      inputMutation.mutate({ ...context, event });
    },
    [inputMutation, requireInputContext],
  );

  const pointFromEvent = useCallback(
    (event: GestureResponderEvent): DisplayPoint | null => {
      if (!displayRect) return null;
      const x = Math.min(displayRect.width, Math.max(0, event.nativeEvent.locationX));
      const y = Math.min(displayRect.height, Math.max(0, event.nativeEvent.locationY));
      return { x, y, width: displayRect.width, height: displayRect.height };
    },
    [displayRect],
  );

  const finishPointerGesture = useCallback(
    (event: GestureResponderEvent) => {
      const start = dragStartRef.current;
      const end = pointFromEvent(event);
      dragStartRef.current = null;
      if (!start || !end) return;
      lastPointRef.current = { x: end.x, y: end.y };
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      if (distance >= DRAG_THRESHOLD) {
        if (swipeMode === "scroll") {
          const current = stateRef.current;
          const scale = current ? current.viewport.width / end.width : 1;
          sendEvent({
            kind: "scroll",
            point: { ...start, width: end.width, height: end.height },
            deltaX: clampScrollDelta((start.x - end.x) * scale),
            deltaY: clampScrollDelta((start.y - end.y) * scale),
          });
          return;
        }
        sendEvent({
          kind: "drag",
          start: { ...start, width: end.width, height: end.height },
          end,
          button: interactionMode === "right" ? "right" : "left",
        });
        return;
      }
      sendEvent({
        kind: "click",
        point: end,
        button: interactionMode === "right" ? "right" : "left",
        clickCount: interactionMode === "double" ? 2 : 1,
      });
    },
    [interactionMode, pointFromEvent, sendEvent, swipeMode],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => canSendInput,
        onMoveShouldSetPanResponder: () => canSendInput,
        onPanResponderGrant: (event) => {
          const point = pointFromEvent(event);
          dragStartRef.current = point ? { x: point.x, y: point.y } : null;
        },
        onPanResponderRelease: finishPointerGesture,
        onPanResponderTerminate: () => {
          dragStartRef.current = null;
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [canSendInput, finishPointerGesture, pointFromEvent],
  );

  const handleCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);

  const takeControl = useCallback(
    (takeover: boolean) => {
      if (!viewerToken || acquireMutation.isPending) return;
      mutationEpochRef.current += 1;
      acquireMutation.mutate({ viewerToken, takeover });
    },
    [acquireMutation, viewerToken],
  );
  const release = useCallback(() => {
    const viewer = activeViewerTokenRef.current;
    if (
      !viewer ||
      !controlToken ||
      stateRef.current?.controller !== "self" ||
      releaseMutation.isPending
    ) {
      return;
    }
    mutationEpochRef.current += 1;
    releaseMutation.mutate({ viewerToken: viewer, controlToken });
  }, [controlToken, releaseMutation]);

  const navigate = useCallback(
    (action: "back" | "forward" | "reload" | "goto", url?: string) => {
      const context = requireControlContext();
      if (!context || navigateMutation.isPending) return;
      if (action === "goto") {
        const nextUrl = url?.trim();
        if (!nextUrl) {
          setOperationError("Enter an address to navigate.");
          return;
        }
        mutationEpochRef.current += 1;
        navigateMutation.mutate({ ...context, action: { kind: "goto", url: nextUrl } });
        return;
      }
      mutationEpochRef.current += 1;
      navigateMutation.mutate({ ...context, action: { kind: action } });
    },
    [navigateMutation, requireControlContext],
  );

  const applyViewport = useCallback(() => {
    const context = requireControlContext();
    if (!context || resizeMutation.isPending) return;
    const width = Number(viewportWidth);
    const height = Number(viewportHeight);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < MIN_VIEWPORT.width ||
      width > MAX_VIEWPORT.width ||
      height < MIN_VIEWPORT.height ||
      height > MAX_VIEWPORT.height
    ) {
      setOperationError(
        `Viewport must be ${MIN_VIEWPORT.width}–${MAX_VIEWPORT.width} × ${MIN_VIEWPORT.height}–${MAX_VIEWPORT.height}.`,
      );
      return;
    }
    mutationEpochRef.current += 1;
    resizeMutation.mutate({ ...context, viewport: { width, height } });
  }, [requireControlContext, resizeMutation, viewportHeight, viewportWidth]);

  const selectDevicePreset = useCallback(
    (presetId: DevicePresetId) => {
      const context = requireControlContext();
      if (!context || deviceMutation.isPending) return;
      mutationEpochRef.current += 1;
      setDevicePickerOpen(false);
      deviceMutation.mutate({ ...context, presetId });
    },
    [deviceMutation, requireControlContext],
  );

  const scroll = useCallback(
    (deltaX: number, deltaY: number) => {
      if (!displayRect) return;
      const previous = lastPointRef.current;
      const x = previous && previous.x <= displayRect.width ? previous.x : displayRect.width / 2;
      const y = previous && previous.y <= displayRect.height ? previous.y : displayRect.height / 2;
      sendEvent({
        kind: "scroll",
        point: { x, y, width: displayRect.width, height: displayRect.height },
        deltaX,
        deltaY,
      });
    },
    [displayRect, sendEvent],
  );

  const sendText = useCallback(() => {
    if (!typeDraft || inputMutation.isPending) return;
    sendEvent({ kind: "type", text: typeDraft });
  }, [inputMutation.isPending, sendEvent, typeDraft]);

  const reconnect = useCallback(() => {
    if (attachQuery.isFetching) return;
    mutationEpochRef.current += 1;
    setReconnecting(true);
    setControlToken(null);
    setOperationError(null);
    frameRef.current = null;
    stateRef.current = null;
    setFrame(null);
    setState(null);
    void attachQuery.refetch({ cancelRefetch: false }).then((result) => {
      if (!result.error) setReconnecting(false);
    });
  }, [attachQuery.isFetching, attachQuery.refetch]);

  const connectionError = attachQuery.error ?? captureQuery.error;
  const visibleError =
    operationError ?? state?.error ?? (connectionError ? errorMessage(connectionError) : null);
  const statusColor =
    state?.status === "ready"
      ? theme.colors.statusSuccess
      : state?.status === "error"
        ? theme.colors.statusDanger
        : theme.colors.statusWarning;
  const statusLabel =
    state?.status === "ready" ? "Ready" : state?.status === "error" ? "Error" : "Starting";
  const leaseExpiry = state?.controllerExpiresAt
    ? new Date(state.controllerExpiresAt).toLocaleTimeString()
    : null;
  const leaseDetail = leaseExpiry ? ` · lease until ${leaseExpiry}` : "";
  const controllerLabel =
    state?.controller === "self"
      ? controlToken
        ? `You have control${leaseDetail}`
        : "Control token unavailable"
      : state?.controller === "other"
        ? `${state.controllerLabel ?? "Another viewer"} has control${leaseDetail}`
        : "Observe-only · no controller";
  const activeDevicePreset = state?.devicePresetId
    ? DEVICE_PRESETS.find(({ id }) => id === state.devicePresetId)
    : null;
  const deviceLabel = activeDevicePreset?.label ?? "Custom display";
  const transportLabel = currentFrame?.transport === "cdp-screencast" ? "CDP" : "fallback";
  const frameSummary = currentFrame
    ? layout.compact
      ? `${currentFrame.width}×${currentFrame.height} · ${transportLabel}`
      : `${currentFrame.width} × ${currentFrame.height} · ${Math.ceil(currentFrame.byteLength / BYTES_PER_KIBIBYTE)} KB · ${transportLabel} · ${deviceLabel}`
    : state
      ? `${state.viewport.width} × ${state.viewport.height} canonical`
      : "No frame";

  let controlAction: ReactNode = null;
  if (state?.controller === "self" && controlToken) {
    controlAction = (
      <ControlButton
        styles={styles}
        theme={theme}
        label="Release"
        icon="LogOut"
        disabled={anyMutationPending}
        onPress={release}
      />
    );
  } else if (state?.controller === "other") {
    controlAction = (
      <ControlButton
        styles={styles}
        theme={theme}
        label="Take over"
        icon="Crown"
        danger
        disabled={!viewerToken || anyMutationPending}
        onPress={() => takeControl(true)}
      />
    );
  } else {
    controlAction = (
      <ControlButton
        styles={styles}
        theme={theme}
        label={state?.controller === "self" ? "Reacquire" : "Take control"}
        icon="MousePointer2"
        primary
        disabled={!viewerToken || anyMutationPending}
        onPress={() => takeControl(false)}
      />
    );
  }

  const imageStyle = displayRect
    ? [
        styles.frame,
        {
          left: displayRect.x,
          top: displayRect.y,
          width: displayRect.width,
          height: displayRect.height,
        },
      ]
    : styles.frame;
  const interactionStyle = displayRect
    ? [
        styles.interactionLayer,
        {
          left: displayRect.x,
          top: displayRect.y,
          width: displayRect.width,
          height: displayRect.height,
        },
      ]
    : styles.interactionLayer;

  return (
    <View style={styles.screen}>
      <View style={styles.chrome}>
        <View style={styles.addressRow}>
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Back"
            icon="ArrowLeft"
            disabled={!canControl || !state?.canGoBack || navigateMutation.isPending}
            onPress={() => navigate("back")}
          />
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Forward"
            icon="ArrowRight"
            disabled={!canControl || !state?.canGoForward || navigateMutation.isPending}
            onPress={() => navigate("forward")}
          />
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Reload"
            icon="RotateCw"
            disabled={!canControl || navigateMutation.isPending}
            onPress={() => navigate("reload")}
          />
          <Field
            styles={styles}
            theme={theme}
            value={addressDraft}
            accessibilityLabel="Browser address"
            placeholder="Enter a URL"
            editable={canControl && !navigateMutation.isPending}
            maxLength={MAX_URL_LENGTH}
            returnKeyType="go"
            style={[styles.addressInput, styles.chromeAddressInput]}
            onChangeText={setAddressDraft}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            onSubmit={() => navigate("goto", addressDraft)}
          />
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label={`Device: ${deviceLabel}`}
            icon={activeDevicePreset?.isMobile ? "Smartphone" : "Monitor"}
            selected={Boolean(activeDevicePreset)}
            disabled={!canControl || deviceMutation.isPending}
            onPress={() => setDevicePickerOpen(true)}
          />
        </View>
      </View>

      <View style={styles.statusRow}>
        <View style={styles.statusSummary}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.statusText}>{state ? statusLabel : "Connecting"}</Text>
          <Text style={styles.mutedText}>
            {state
              ? `${state.viewerCount} viewer${state.viewerCount === 1 ? "" : "s"}`
              : viewerLabel}
          </Text>
          <Text numberOfLines={1} style={styles.controllerText}>
            {state ? controllerLabel : "Attaching to workspace browser"}
          </Text>
        </View>
        <View style={styles.actionRow}>{controlAction}</View>
      </View>

      {visibleError ? (
        <ErrorNotice
          styles={styles}
          theme={theme}
          message={visibleError}
          action={connectionError || reconnecting ? "Reconnect" : undefined}
          onAction={connectionError || reconnecting ? reconnect : undefined}
          actionDisabled={attachQuery.isFetching}
        />
      ) : null}

      <View style={styles.canvasShell}>
        <View style={styles.canvas} onLayout={handleCanvasLayout}>
          {frameUri && displayRect && !imageError ? (
            <>
              <Image
                accessibilityLabel={
                  state?.title ? `Shared browser: ${state.title}` : "Shared browser frame"
                }
                accessibilityRole="image"
                onError={() => {
                  frameRef.current = null;
                  setImageError(true);
                  void captureQuery.refetch({ cancelRefetch: false });
                }}
                resizeMode="contain"
                source={{ uri: frameUri }}
                style={imageStyle}
              />
              <View
                {...panResponder.panHandlers}
                accessible={false}
                pointerEvents={canSendInput ? "auto" : "none"}
                style={interactionStyle}
              />
            </>
          ) : imageError ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Frame could not be displayed"
              detail="The JPEG frame was received but the client could not decode it. Capture will continue."
            />
          ) : connectionError ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Connection failed"
              detail="Reconnect to attach a fresh viewer and resume frame capture."
            />
          ) : state?.status === "error" ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Browser unavailable"
              detail={state.error ?? "The browser session reported an error."}
            />
          ) : (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title={
                attachQuery.isPending || reconnecting
                  ? "Connecting to shared browser"
                  : "Waiting for frame"
              }
              detail="The browser remains active in this workspace when viewers detach."
              loading={attachQuery.isPending || reconnecting || captureQuery.isFetching}
            />
          )}
        </View>
        <View style={styles.canvasFooter}>
          <Text numberOfLines={1} style={styles.canvasFooterText}>
            {state?.title || state?.url || "Shared browser"}
          </Text>
          <Text numberOfLines={1} style={styles.canvasFooterText}>
            {frameSummary}
          </Text>
        </View>
      </View>

      <View style={styles.controls}>
        {layout.compact ? (
          <>
            <View style={styles.mobileRow}>
              <Field
                styles={styles}
                theme={theme}
                value={typeDraft}
                accessibilityLabel="Text to type in the shared browser"
                placeholder={canSendInput ? "Type into the page" : "Take control to type"}
                editable={canSendInput}
                maxLength={MAX_TEXT_LENGTH}
                returnKeyType="send"
                style={[styles.typeInput, styles.buttonLarge]}
                onChangeText={setTypeDraft}
                onSubmit={sendText}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Send"
                icon="Send"
                primary
                large
                disabled={!canSendInput || !typeDraft || inputMutation.isPending}
                onPress={sendText}
              />
            </View>
            <View style={styles.mobileRow}>
              <ControlButton
                styles={styles}
                theme={theme}
                label={swipeMode === "scroll" ? "Swipe scrolls" : "Swipe drags"}
                accessibilityLabel="Pointer and scrolling options"
                icon="MousePointer2"
                large
                fill
                disabled={!canControl}
                onPress={() => setPointerSheetOpen(true)}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Keys"
                icon="Keyboard"
                large
                fill
                disabled={!canSendInput}
                onPress={() => setKeysSheetOpen(true)}
              />
            </View>
          </>
        ) : (
          <>
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.toolbarContent}
            >
              <View style={styles.controlStrip}>
                <Text style={styles.stripLabel}>Tap</Text>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Click"
                  selected={interactionMode === "click"}
                  disabled={!canSendInput}
                  onPress={() => setInteractionMode("click")}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Double"
                  selected={interactionMode === "double"}
                  disabled={!canSendInput}
                  onPress={() => setInteractionMode("double")}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Right"
                  selected={interactionMode === "right"}
                  disabled={!canSendInput}
                  onPress={() => setInteractionMode("right")}
                />
                <View style={styles.separator} />
                <Text style={styles.stripLabel}>Drag</Text>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Scrolls"
                  selected={swipeMode === "scroll"}
                  disabled={!canControl}
                  onPress={() => setSwipeMode("scroll")}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Drags"
                  selected={swipeMode === "drag"}
                  disabled={!canControl}
                  onPress={() => setSwipeMode("drag")}
                />
                <View style={styles.separator} />
                <Text style={styles.stripLabel}>Scroll</Text>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="←"
                  accessibilityLabel="Scroll left"
                  disabled={!canSendInput}
                  onPress={() => scroll(-SCROLL_STEP, 0)}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="↑"
                  accessibilityLabel="Scroll up"
                  disabled={!canSendInput}
                  onPress={() => scroll(0, -SCROLL_STEP)}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="↓"
                  accessibilityLabel="Scroll down"
                  disabled={!canSendInput}
                  onPress={() => scroll(0, SCROLL_STEP)}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="→"
                  accessibilityLabel="Scroll right"
                  disabled={!canSendInput}
                  onPress={() => scroll(SCROLL_STEP, 0)}
                />
              </View>
            </ScrollView>

            <View style={styles.typeRow}>
              <Field
                styles={styles}
                theme={theme}
                value={typeDraft}
                accessibilityLabel="Text to type in the shared browser"
                placeholder={
                  canSendInput
                    ? "Type into the focused page element"
                    : "Take control and focus a page field"
                }
                editable={canSendInput}
                maxLength={MAX_TEXT_LENGTH}
                returnKeyType="send"
                style={styles.typeInput}
                onChangeText={setTypeDraft}
                onSubmit={sendText}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Send"
                icon="Send"
                primary
                disabled={!canSendInput || !typeDraft || inputMutation.isPending}
                onPress={sendText}
              />
            </View>
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.keysContent}
            >
              <Text style={styles.stripLabel}>Keys</Text>
              {SPECIAL_KEYS.map(({ key, label }) => (
                <ControlButton
                  key={key}
                  styles={styles}
                  theme={theme}
                  label={label}
                  accessibilityLabel={`Send ${key} key`}
                  disabled={!canSendInput}
                  onPress={() => sendEvent({ kind: "key", key })}
                />
              ))}
            </ScrollView>
          </>
        )}
      </View>

      <Modal
        title="Pointer and scrolling"
        icon={<Icon name="MousePointer2" size={18} color={theme.colors.foreground} />}
        open={pointerSheetOpen}
        onOpenChange={setPointerSheetOpen}
      >
        <Modal.Content>
          <View style={styles.sheetContent}>
            <Text style={styles.stripLabel}>Swipe gesture</Text>
            <View style={styles.sheetGrid}>
              <ControlButton
                styles={styles}
                theme={theme}
                label="Scrolls the page"
                large
                fill
                selected={swipeMode === "scroll"}
                disabled={!canControl}
                onPress={() => setSwipeMode("scroll")}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Drags content"
                large
                fill
                selected={swipeMode === "drag"}
                disabled={!canControl}
                onPress={() => setSwipeMode("drag")}
              />
            </View>
            <Text style={styles.stripLabel}>Tap action</Text>
            <View style={styles.sheetGrid}>
              <ControlButton
                styles={styles}
                theme={theme}
                label="Click"
                large
                fill
                selected={interactionMode === "click"}
                disabled={!canControl}
                onPress={() => setInteractionMode("click")}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Double"
                large
                fill
                selected={interactionMode === "double"}
                disabled={!canControl}
                onPress={() => setInteractionMode("double")}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Right"
                large
                fill
                selected={interactionMode === "right"}
                disabled={!canControl}
                onPress={() => setInteractionMode("right")}
              />
            </View>
            <Text style={styles.stripLabel}>Nudge scroll</Text>
            <View style={styles.sheetPad}>
              <ControlButton
                styles={styles}
                theme={theme}
                label="↑"
                accessibilityLabel="Scroll up"
                pad
                disabled={!canSendInput}
                onPress={() => scroll(0, -SCROLL_STEP)}
              />
              <View style={styles.sheetPadRow}>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="←"
                  accessibilityLabel="Scroll left"
                  pad
                  disabled={!canSendInput}
                  onPress={() => scroll(-SCROLL_STEP, 0)}
                />
                <View style={styles.padSpacer} />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="→"
                  accessibilityLabel="Scroll right"
                  pad
                  disabled={!canSendInput}
                  onPress={() => scroll(SCROLL_STEP, 0)}
                />
              </View>
              <ControlButton
                styles={styles}
                theme={theme}
                label="↓"
                accessibilityLabel="Scroll down"
                pad
                disabled={!canSendInput}
                onPress={() => scroll(0, SCROLL_STEP)}
              />
            </View>
            <Text style={styles.devicePresetDetail}>
              Tap the page to click. Swipe to scroll or drag, depending on the gesture above.
            </Text>
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title="Keyboard keys"
        icon={<Icon name="Keyboard" size={18} color={theme.colors.foreground} />}
        open={keysSheetOpen}
        onOpenChange={setKeysSheetOpen}
      >
        <Modal.Content>
          <View style={styles.sheetContent}>
            <View style={styles.sheetGrid}>
              {SPECIAL_KEYS.map(({ key, label }) => (
                <ControlButton
                  key={key}
                  styles={styles}
                  theme={theme}
                  label={label}
                  accessibilityLabel={`Send ${key} key`}
                  large
                  disabled={!canSendInput}
                  onPress={() => sendEvent({ kind: "key", key })}
                />
              ))}
            </View>
            <Text style={styles.devicePresetDetail}>
              Keys go to the page element that currently has focus in the shared browser.
            </Text>
          </View>
        </Modal.Content>
      </Modal>
      <Modal
        title="Device emulation"
        icon={<Icon name="Smartphone" size={18} color={theme.colors.foreground} />}
        open={devicePickerOpen}
        onOpenChange={setDevicePickerOpen}
      >
        <Modal.Content>
          <View style={styles.deviceModalContent}>
            {DEVICE_PRESETS.map((preset) => {
              const selected = state?.devicePresetId === preset.id;
              return (
                <Pressable
                  key={preset.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Emulate ${preset.label}`}
                  accessibilityState={{ selected }}
                  disabled={!canControl || deviceMutation.isPending}
                  onPress={() => selectDevicePreset(preset.id)}
                  style={({ pressed }) => [
                    styles.devicePresetRow,
                    selected ? styles.devicePresetRowSelected : null,
                    pressed ? styles.buttonPressed : null,
                    !canControl ? styles.buttonDisabled : null,
                  ]}
                >
                  <Icon
                    name={preset.isMobile ? "Smartphone" : "Monitor"}
                    size={18}
                    color={selected ? theme.colors.accent : theme.colors.foregroundMuted}
                  />
                  <Text style={styles.devicePresetText}>{preset.label}</Text>
                  <Text style={styles.devicePresetDetail}>
                    {preset.viewport.width} × {preset.viewport.height}
                  </Text>
                </Pressable>
              );
            })}
            <Text style={styles.stripLabel}>Custom viewport</Text>
            <View style={styles.customViewportRow}>
              <Field
                styles={styles}
                theme={theme}
                value={viewportWidth}
                accessibilityLabel="Canonical viewport width"
                editable={canControl && !resizeMutation.isPending}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={4}
                selectTextOnFocus
                style={styles.viewportField}
                onChangeText={setViewportWidth}
                onSubmit={applyViewport}
              />
              <Text style={styles.multiply}>×</Text>
              <Field
                styles={styles}
                theme={theme}
                value={viewportHeight}
                accessibilityLabel="Canonical viewport height"
                editable={canControl && !resizeMutation.isPending}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={4}
                selectTextOnFocus
                style={styles.viewportField}
                onChangeText={setViewportHeight}
                onSubmit={applyViewport}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Apply"
                disabled={!canControl || resizeMutation.isPending}
                onPress={applyViewport}
              />
            </View>
            <Text style={styles.devicePresetDetail}>
              Presets change viewport, touch behavior, and user agent. Rendering remains Chromium.
            </Text>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
