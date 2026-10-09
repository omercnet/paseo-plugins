/**
 * Workspace browser panel orchestration: viewer/control ownership, current
 * decoded receipts, media handoff and menu actions. Native/DOM forwarding and
 * presentation models live in focused counterpart hooks; this module never
 * replays published mutations or substitutes visible pixels for input authority.
 */
import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserState,
  beginBrowserGestureRpc,
  captureBrowserRpc,
  DEVICE_PRESETS,
  type DevicePresetId,
  detachBrowserRpc,
  didBrowserRuntimeRestart,
  endBrowserGestureRpc,
  isBrowserStateCurrent,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  navigateBrowserRpc,
  releaseControlRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "../shared/browser";
import type { BrowserFrameAuthority } from "../shared/browser-video";
import { groupResolutionPresets } from "../shared/resolution-menu";
import { liveInputAllowed } from "./browser-canvas-input";
import { type BrowserCanvasDisplayMode, getBrowserCanvasLayout } from "./browser-canvas-layout";
import { BrowserCanvasViewport } from "./browser-canvas-viewport";
import {
  CanvasPlaceholder,
  ChromeIconButton,
  ControlButton,
  ErrorNotice,
  Field,
} from "./browser-chrome";
import { ComposeTextControls } from "./browser-compose-controls";
import { type EmulationSelection, matchingResolutionPresetId } from "./browser-emulation-mode";
import type { FrameCandidate } from "./browser-frame-buffer";
import { BrowserFrameImage } from "./browser-frame-image";
import { createStyles, DIMENSION, SPACE } from "./browser-panel-styles";
import { BrowserResolutionPicker } from "./browser-resolution-picker";
import {
  BrowserMenuHeading,
  BrowserMenuItem,
  BrowserMenuSeparator,
  BrowserToolbarMenu,
} from "./browser-toolbar-menu";
import { BrowserVideoSurface } from "./browser-video-surface";
import { isExpiredBrowserViewerError } from "./browser-viewer-recovery";
import { createFrameLifecycle } from "./frame-lifecycle";
import { useBrowserCanvasInput } from "./use-browser-canvas-input";
import { useBrowserCaptureDensity } from "./use-browser-capture-density";
import { useBrowserEmulationMode } from "./use-browser-emulation-mode";
import { useBrowserFrameBuffer } from "./use-browser-frame-buffer";
import { useBrowserImageCapture } from "./use-browser-image-capture";
import { useBrowserScopedMutation } from "./use-browser-scoped-mutation";
import { useBrowserVideo } from "./use-browser-video";
import { useBrowserViewerRecovery } from "./use-browser-viewer-recovery";
import { useResolutionFavorites } from "./use-resolution-favorites";

// Preserve the existing contribution entry/test import while ownership lives in a focused module.
export { contributeSharedBrowserClient } from "./browser-client-presence";

const MAX_VIEWER_LABEL_LENGTH = 64;
const MAX_URL_LENGTH = 8_192;
const BYTES_PER_KIBIBYTE = 1_024;

type SpecialKey = Extract<BrowserInputEvent, { kind: "key" }>["key"];

interface Size {
  width: number;
  height: number;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The shared browser request failed.";
}
function hasUnknownMutationOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (code === "unknown_outcome") return true;
  if (
    code === "transport_closed_after_dispatch" ||
    code === "transport_lost_after_dispatch" ||
    code === "rpc_timeout" ||
    name === "RpcTimeoutError" ||
    name === "TransportLostAfterDispatchError"
  ) {
    return true;
  }
  const dispatched = record.dispatched === true || record.requestDispatched === true;
  return dispatched && /(transport|connection|timeout)/.test(code || name.toLowerCase());
}

/** A painted document may remain visible within the same source and geometry. */
function isFrameDisplayCurrent(frame: BrowserFrameAuthority, state: BrowserState): boolean {
  return Boolean(
    frame.runtimeId &&
      state.runtimeId &&
      frame.captureEpoch !== undefined &&
      state.bridgeEpoch !== undefined &&
      frame.sessionId === state.sessionId &&
      frame.runtimeId === state.runtimeId &&
      frame.captureEpoch === state.bridgeEpoch &&
      frame.viewportGeneration === state.viewportGeneration,
  );
}

function isFrameCurrent(frame: BrowserFrameAuthority, state: BrowserState): boolean {
  return (
    frame.sessionId === state.sessionId &&
    (!frame.runtimeId || !state.runtimeId || frame.runtimeId === state.runtimeId) &&
    (frame.captureEpoch === undefined ||
      state.bridgeEpoch === undefined ||
      frame.captureEpoch === state.bridgeEpoch) &&
    frame.navigationGeneration === state.navigationGeneration &&
    frame.viewportGeneration === state.viewportGeneration
  );
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
  const setCaptureDensity = useRpc(setCaptureDensityRpc);
  const sendBrowserInput = useRpc(sendBrowserInputRpc);
  const beginBrowserGesture = useRpc(beginBrowserGestureRpc);
  const updateBrowserGesture = useRpc(updateBrowserGestureRpc);
  const endBrowserGesture = useRpc(endBrowserGestureRpc);

  const mountedRef = useRef(false);
  const activeViewerTokenRef = useRef<string | null>(null);
  const stateRef = useRef<BrowserState | null>(null);
  // Lease observations can change while acquisition awaits with no local token.
  // Count ownership transitions, not expiry renewals or ordinary media frames.
  const controllerObservationRevision = useRef(0);
  const frameRef = useRef<BrowserFrame | null>(null);
  const committedViewport = useRef<{ sessionId: string; generation: number } | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [inputLifecycle] = useState(createFrameLifecycle);
  const [legacyInputBusy, setLegacyInputBusy] = useState(false);
  // A visual-only old-read paint cannot wake strict initial-admission waiters.
  const [admittedPaint, setAdmittedPaint] = useState<{ frameId: string; epoch: number } | null>(
    null,
  );
  /** Notify initial-admission waiters only when the actual painted receipt gains input authority. */
  const publishAdmittedPaint = (frameId: string, epoch: number) => {
    setAdmittedPaint((previous) => {
      if (previous?.frameId === frameId && previous.epoch === epoch) return previous;
      return { frameId, epoch };
    });
  };

  const [state, setState] = useState<BrowserState | null>(null);
  const [controlToken, setControlToken] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [viewportWidth, setViewportWidth] = useState("");
  const [viewportHeight, setViewportHeight] = useState("");
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const preferences = useResolutionFavorites(host.id);
  const [keysSubmenuOpen, setKeysSubmenuOpen] = useState(false);
  const keysAnchorRef = useRef<View | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<"display" | "actions" | null>(null);
  const [scaleMode, setScaleMode] = useState<BrowserCanvasDisplayMode>("fit");
  const paneRef = useRef<View | null>(null);
  const displayAnchorRef = useRef<View | null>(null);
  const actionsAnchorRef = useRef<View | null>(null);
  const [paneSize, setPaneSize] = useState<Size>({ width: 0, height: 0 });
  const menuRestoreFocus = useRef(true);
  const closeToolbarMenu = useCallback((restoreFocus = true) => {
    menuRestoreFocus.current = restoreFocus;
    setKeysSubmenuOpen(false);
    setToolbarMenu(null);
  }, []);
  const toggleToolbarMenu = (menu: "display" | "actions") => {
    menuRestoreFocus.current = true;
    setKeysSubmenuOpen(false);
    setToolbarMenu((current) => (current === menu ? null : menu));
  };
  const [composeRequest, setComposeRequest] = useState<{
    id: number;
    ownershipKey: string;
  } | null>(null);
  const nextComposeRequest = useRef(0);
  const [activeInput, setActiveInput] = useState(false);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCandidateCurrent = useCallback((candidate: FrameCandidate) => {
    const current = stateRef.current;
    return (
      mountedRef.current &&
      candidate.viewerToken === activeViewerTokenRef.current &&
      candidate.mutationEpoch === inputLifecycle.epoch &&
      current !== null &&
      isFrameCurrent(candidate.frame, current)
    );
  }, []);
  const { buffer, frame, receive, settled, discardObsoletePending, reset } = useBrowserFrameBuffer(
    frameRef,
    isCandidateCurrent,
  );
  const imageError = buffer.imageError;

  const acceptState = useCallback(
    (next: BrowserState) => {
      const previous = stateRef.current;
      if (previous && !isBrowserStateCurrent(previous, next)) return false;
      // Server state projects "self" against this exact viewer token. Media can
      // observe our acquisition before its RPC returns the control token, so
      // that transition must not revoke its own still-pending settlement.
      // Competing ownership and subsequent release still advance the fence.
      const observesOwnAcquisition = previous?.controller !== "self" && next.controller === "self";
      if (
        previous &&
        !observesOwnAcquisition &&
        (previous.controller !== next.controller ||
          previous.controllerLabel !== next.controllerLabel)
      ) {
        controllerObservationRevision.current += 1;
      }
      const currentFrame = frameRef.current;
      if (previous && didBrowserRuntimeRestart(previous, next)) {
        setRuntimeNotice(
          "Browser restarted. The preserved viewer connection now targets the new runtime.",
        );
        setControlToken(null);
      }
      if (currentFrame && !isFrameCurrent(currentFrame, next)) {
        lastPointRef.current = null;
      }
      stateRef.current = next;
      // Repeated captures in the new generation must not cancel its slow decoder.
      discardObsoletePending();
      setState(next);
      return true;
    },
    [discardObsoletePending],
  );

  const attachQuery = useQuery({
    queryKey: ["shared-browser", "attach", host.id, workspaceId, viewerLabel],
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
    reset();
    inputLifecycle.bump();
    inputLifecycle.reset();
    setLegacyInputBusy(false);
    setControlToken(null);
    setOperationError(null);
    setRuntimeNotice(null);
  }, [reset, workspaceId, host.id, inputLifecycle]);

  useLayoutEffect(() => {
    committedViewport.current = state
      ? { sessionId: state.sessionId, generation: state.viewportGeneration }
      : null;
  }, [state?.sessionId, state?.viewportGeneration]);

  const video = useBrowserVideo({
    viewerToken,
    quality: "high",
    bitrate: preferences.videoBitrate,
    fps: preferences.videoFps,
    epoch: () => inputLifecycle.epoch,
    viewport: () => stateRef.current?.viewport ?? null,
    isCurrent: (packet, epoch) =>
      mountedRef.current &&
      activeViewerTokenRef.current === viewerToken &&
      epoch === inputLifecycle.epoch &&
      committedViewport.current?.sessionId === packet.frame.sessionId &&
      committedViewport.current?.generation === packet.frame.viewportGeneration &&
      stateRef.current !== null &&
      isFrameCurrent(packet.frame, stateRef.current),
    isDisplayCurrent: (packet) => {
      const current = stateRef.current;
      return (
        mountedRef.current &&
        activeViewerTokenRef.current === viewerToken &&
        current !== null &&
        isFrameDisplayCurrent(packet.frame, current)
      );
    },
    acceptState,
    onPresented: (packet, epoch) => {
      inputLifecycle.accept(epoch, packet.frame);
      publishAdmittedPaint(packet.frame.frameId, epoch);
      setLegacyInputBusy(inputLifecycle.busy);
    },
  });

  const {
    query: captureQuery,
    refreshCapture,
    retryFrameCapture,
  } = useBrowserImageCapture({
    active: !video.supported || video.active,
    viewerToken,
    quality: preferences.captureQuality,
    activeInput,
    fallbackRevision: video.fallbackRevision,
    videoOwnsPresentation: Boolean(
      video.front &&
        !video.fallbackRevision &&
        state &&
        isFrameDisplayCurrent(video.front.frame, state),
    ),
    hasVideoPresentation: () =>
      Boolean(
        video.front &&
          !video.fallbackRevision &&
          activeViewerTokenRef.current === viewerToken &&
          stateRef.current &&
          isFrameDisplayCurrent(video.front.frame, stateRef.current),
      ),
    refreshVideo: video.refresh,
    mutationEpoch: () => inputLifecycle.epoch,
    knownFrame: () => frameRef.current,
    capture: captureBrowser,
  });

  useEffect(() => {
    const result = captureQuery.data;
    if (
      !result ||
      result.viewerToken !== activeViewerTokenRef.current ||
      result.captureQuality !== preferences.captureQuality ||
      result.mutationEpoch !== inputLifecycle.epoch ||
      !acceptState(result.state)
    ) {
      return;
    }
    if (result.frame && isFrameCurrent(result.frame, result.state)) {
      receive({
        frame: result.frame,
        viewport: result.state.viewport,
        viewerToken: result.viewerToken,
        mutationEpoch: result.mutationEpoch,
        fallbackRevision: result.fallbackRevision,
      });
    }
  }, [acceptState, captureQuery.data, preferences.captureQuality, receive]);

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

  const mutationFailed = useCallback(
    (error: unknown) => {
      const message = errorMessage(error);
      setOperationError(
        hasUnknownMutationOutcome(error)
          ? `${message} Mutation outcome is unknown; state refreshed and the action was not replayed.`
          : message,
      );
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

  const mutationIdentity = JSON.stringify([
    host.id,
    workspaceId,
    viewerToken,
    controlToken,
    controllerObservationRevision.current,
  ]);
  // Ref observations revoke settlement immediately, before the state commit.
  const currentMutationIdentity = () =>
    JSON.stringify([
      host.id,
      workspaceId,
      activeViewerTokenRef.current,
      controlToken,
      controllerObservationRevision.current,
    ]);
  const acquireMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: acquireControl,
    onSuccess: (result) => {
      setControlToken(result.controlToken);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const releaseMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: releaseControl,
    onSuccess: (result) => {
      setControlToken(null);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const navigateMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: navigateBrowser,
    onSuccess: (result) => {
      mutationSucceeded(result.state);
      // Only acknowledged navigation grants explicit viewing recovery. Ordinary
      // gesture/image refresh does not rearm an exhausted video reader.
      video.retry();
    },
    onError: mutationFailed,
  });
  const resizeMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: resizeBrowser,
    onSuccess: (result) => {
      setDevicePickerOpen(false);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const deviceMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: applyDevicePreset,
    onSuccess: (result) => mutationSucceeded(result.state),
    onError: mutationFailed,
  });
  // Upstream's settlement gate protects discrete key controls and native text fallback.
  // Continuous gestures retain their own ordered channel without waiting per event.
  const settleLegacyInput = () => {
    inputLifecycle.settle();
    setLegacyInputBusy(true);
  };
  const inputMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: sendBrowserInput,
    onSuccess: (result) => {
      settleLegacyInput();
      mutationSucceeded(result.state);
    },
    onError: (error) => {
      settleLegacyInput();
      mutationFailed(error);
    },
  });

  const densityControl = useBrowserCaptureDensity({
    identity: JSON.stringify([host.id, workspaceId, viewerToken, controlToken]),
    current: () => {
      const current = stateRef.current;
      const viewer = activeViewerTokenRef.current;
      if (viewingExpired || !current || !viewer || !controlToken || current.controller !== "self")
        return null;
      return {
        state: current,
        context: {
          viewerToken: viewer,
          controlToken,
          expected: {
            sessionId: current.sessionId,
            navigationGeneration: current.navigationGeneration,
            viewportGeneration: current.viewportGeneration,
            ...(current.runtimeId ? { runtimeId: current.runtimeId } : {}),
            ...(current.bridgeEpoch !== undefined ? { bridgeEpoch: current.bridgeEpoch } : {}),
          },
        },
      };
    },
    change: setCaptureDensity,
    beforeChange: () => inputLifecycle.bump(),
    onSuccess: mutationSucceeded,
    onError: mutationFailed,
  });

  const anyMutationPending =
    acquireMutation.isPending ||
    releaseMutation.isPending ||
    navigateMutation.isPending ||
    resizeMutation.isPending ||
    densityControl.pending ||
    deviceMutation.isPending ||
    inputMutation.isPending;
  const videoViewerExpired =
    video.errorViewerToken === viewerToken && isExpiredBrowserViewerError(video.error);
  const viewingExpired = videoViewerExpired || isExpiredBrowserViewerError(captureQuery.error);
  const canControl = Boolean(
    viewerToken && controlToken && state?.controller === "self" && !viewingExpired,
  );
  const frontLayer = buffer.front === null ? null : buffer.layers[buffer.front];
  useLayoutEffect(() => {
    const candidate = frontLayer?.candidate;
    if (
      candidate &&
      candidate.fallbackRevision === video.fallbackRevision &&
      candidate.mutationEpoch === inputLifecycle.epoch &&
      candidate.viewerToken === viewerToken &&
      state &&
      isFrameCurrent(candidate.frame, state)
    )
      video.completeFallback(candidate.fallbackRevision ?? 0);
  }, [frontLayer, video.fallbackRevision, state, viewerToken, inputLifecycle]);
  const videoFrame =
    video.front && state && isFrameCurrent(video.front.frame, state) ? video.front.frame : null;
  const currentFrame =
    videoFrame ??
    (frame &&
    state &&
    frontLayer?.candidate.viewerToken === viewerToken &&
    isFrameCurrent(frame, state)
      ? frame
      : null);
  useEffect(() => {
    const candidate = frontLayer?.candidate;
    if (videoFrame || !frame || !candidate || candidate.mutationEpoch !== inputLifecycle.epoch)
      return;
    inputLifecycle.accept(candidate.mutationEpoch, frame);
    publishAdmittedPaint(frame.frameId, candidate.mutationEpoch);
    setLegacyInputBusy(inputLifecycle.busy);
  }, [frame, frontLayer, inputLifecycle, videoFrame]);
  const canSendInput =
    canControl && Boolean(currentFrame) && !inputMutation.isPending && !legacyInputBusy;

  // Layout belongs to the decoded front frame. A denser capture adds detail,
  // not a larger 100% layout; scale never writes to the shared browser state.
  const visualFrame = video.front?.frame ?? frame;
  const canvasLayout = useMemo(
    () =>
      visualFrame
        ? getBrowserCanvasLayout(
            containerSize,
            visualFrame,
            video.front
              ? (video.frontViewport ?? visualFrame)
              : (frontLayer?.candidate.viewport ?? state?.viewport ?? visualFrame),
            scaleMode,
          )
        : null,
    [
      containerSize,
      visualFrame,
      frontLayer,
      state?.viewport,
      scaleMode,
      video.front,
      video.frontViewport,
    ],
  );
  const displayRect = canvasLayout?.frameRect ?? null;

  const controlContext = useCallback(() => {
    const viewer = activeViewerTokenRef.current;
    const current = stateRef.current;
    if (viewingExpired || !viewer || !controlToken || !current || current.controller !== "self")
      return null;
    return {
      viewerToken: viewer,
      controlToken,
      expected: {
        sessionId: current.sessionId,
        navigationGeneration: current.navigationGeneration,
        viewportGeneration: current.viewportGeneration,
      },
    };
  }, [controlToken, viewingExpired]);

  const inputContext = useCallback(() => {
    const context = controlContext();
    const current = stateRef.current;
    const targetVideo = video.frontRef.current;
    // A revoked video remains painted until React commits the fallback. Never
    // borrow the JPEG token while those older video pixels still cover it.
    if (video.front && !targetVideo) return null;
    const targetFrame = targetVideo?.frame ?? frameRef.current;
    if (
      !context ||
      !current ||
      !targetFrame ||
      !isFrameCurrent(targetFrame, current) ||
      (!targetVideo && frontLayer?.candidate.viewerToken !== context.viewerToken)
    ) {
      return null;
    }
    return {
      ...context,
      target: {
        frameId: targetFrame.frameId,
        navigationGeneration: targetFrame.navigationGeneration,
        viewportGeneration: targetFrame.viewportGeneration,
      },
    };
  }, [controlContext, frontLayer, video.frontRef, video.front]);

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
      if (!context || inputMutation.isPending || !inputLifecycle.begin()) return;
      setLegacyInputBusy(true);
      inputMutation.mutate({ ...context, event });
    },
    [inputMutation, requireInputContext],
  );

  const liveInputEnabled = liveInputAllowed({
    canSendInput,
    mutationPending:
      navigateMutation.isPending ||
      resizeMutation.isPending ||
      deviceMutation.isPending ||
      releaseMutation.isPending ||
      acquireMutation.isPending,
    modalOpen: devicePickerOpen || toolbarMenu !== null,
  });
  /** Existing channels retain control incarnation while their next frame decodes. */
  const gestureControlContext = useCallback(() => {
    const context = controlContext();
    const current = stateRef.current;
    if (!mountedRef.current || !context || !current?.runtimeId || current.bridgeEpoch === undefined)
      return null;
    return {
      ...context,
      expected: {
        ...context.expected,
        runtimeId: current.runtimeId,
        bridgeEpoch: current.bridgeEpoch,
      },
    };
  }, [controlContext]);

  // Forward physical mouse events and genuine touch on every remote preset.
  const canvasInput = useBrowserCanvasInput({
    authority: () => {
      const input = inputContext();
      const context = gestureControlContext();
      return input && context ? { ...context, target: input.target } : null;
    },
    controlAuthority: gestureControlContext,
    transport: { begin: beginBrowserGesture, update: updateBrowserGesture, end: endBrowserGesture },
    ownershipKey: JSON.stringify([
      viewerToken,
      controlToken,
      state?.sessionId,
      state?.runtimeId,
      state?.bridgeEpoch,
      state?.navigationGeneration,
      state?.viewportGeneration,
      displayRect?.width,
      displayRect?.height,
      containerSize.width,
      containerSize.height,
      scaleMode,
      liveInputEnabled,
    ]),
    decodedFrameId: admittedPaint?.epoch === inputLifecycle.epoch ? admittedPaint.frameId : null,
    enabled: liveInputEnabled,
    displaySize: displayRect,
    viewport: state?.viewport ?? null,
    onState: acceptState,
    onError: mutationFailed,
    onFinish: refreshCapture,
    onPoint: (point) => {
      lastPointRef.current = { x: point.x, y: point.y };
    },
    onActivity: setActiveInput,
    onInputAcknowledged: () => {
      // Pixels requested before the host acknowledged this input cannot authorize
      // the next press, even when their request began after the local press.
      inputLifecycle.bump();
    },
    onInputBoundary: () => {
      inputLifecycle.bump();
    },
  });

  const composeOwnershipKey = JSON.stringify([
    viewerToken,
    controlToken,
    state?.sessionId,
    state?.runtimeId,
    state?.bridgeEpoch,
    state?.navigationGeneration,
    state?.viewportGeneration,
  ]);
  const requestCompose = () => {
    if (!canSendInput) return;
    closeToolbarMenu(false);
    nextComposeRequest.current += 1;
    setComposeRequest({ id: nextComposeRequest.current, ownershipKey: composeOwnershipKey });
  };
  const composeRequestHandled = useCallback((id: number) => {
    setComposeRequest((current) => (current?.id === id ? null : current));
  }, []);

  const handleCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);

  const takeControl = useCallback(
    (takeover: boolean) => {
      if (!viewerToken || acquireMutation.isPending) return;
      inputLifecycle.bump();
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
    inputLifecycle.bump();
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
        inputLifecycle.bump();
        navigateMutation.mutate({ ...context, action: { kind: "goto", url: nextUrl } });
        return;
      }
      inputLifecycle.bump();
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
    inputLifecycle.bump();
    resizeMutation.mutate({ ...context, viewport: { width, height } });
  }, [requireControlContext, resizeMutation, viewportHeight, viewportWidth]);

  const selectDevicePreset = useCallback(
    (presetId: DevicePresetId) => {
      const context = requireControlContext();
      if (!context || deviceMutation.isPending) return;
      inputLifecycle.bump();
      setDevicePickerOpen(false);
      deviceMutation.mutate({ ...context, presetId });
    },
    [deviceMutation, requireControlContext],
  );

  const applyEmulationSelection = useCallback(
    (selection: EmulationSelection) => {
      const context = requireControlContext();
      if (!context || anyMutationPending) return;
      inputLifecycle.bump();
      deviceMutation.mutate({ ...context, ...selection });
    },
    [requireControlContext, anyMutationPending, inputLifecycle, deviceMutation],
  );
  const emulation = useBrowserEmulationMode({
    identity: JSON.stringify([host.id, workspaceId]),
    platform: layout.platform,
    state,
    canControl,
    pending: anyMutationPending,
    apply: applyEmulationSelection,
  });

  const reconnect = useCallback(() => {
    if (attachQuery.isFetching) return;
    inputLifecycle.bump();
    // Immediately revoke local input while the viewing-only reattachment awaits.
    activeViewerTokenRef.current = null;
    setReconnecting(true);
    setControlToken(null);
    setOperationError(null);
    void attachQuery.refetch({ cancelRefetch: false }).then((result) => {
      if (!result.error) setReconnecting(false);
    });
  }, [attachQuery.isFetching, attachQuery.refetch]);

  useBrowserViewerRecovery({
    identity: JSON.stringify([host.id, workspaceId]),
    viewerToken,
    failedViewerToken: videoViewerExpired ? video.errorViewerToken : viewerToken,
    captureError: videoViewerExpired ? video.error : captureQuery.error,
    pending: reconnecting || attachQuery.isFetching,
    reconnect,
  });

  // Expiry belongs to the viewing-only recovery path, not an action failure.
  // A failed reattachment still surfaces its attachQuery error and manual retry.
  const connectionError =
    attachQuery.error ?? (viewingExpired ? null : (captureQuery.error ?? video.error));
  const recoveryError =
    state?.recoveryState === "runtime-unavailable"
      ? (state.error ?? "Browser runtime unavailable.")
      : null;
  const visibleError =
    operationError ??
    recoveryError ??
    state?.error ??
    (connectionError ? errorMessage(connectionError) : null);
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
  const selectedResolutionPresetId = matchingResolutionPresetId(state);
  const deviceLabel = selectedResolutionPresetId
    ? (activeDevicePreset?.label ?? "Custom display")
    : `${emulation.mode === "mobile" ? "Mobile" : "Desktop"} · custom display`;
  const transportLabel =
    video.front && video.fallbackRevision
      ? "Updating video"
      : video.front
        ? "Video"
        : frame?.transport === "cdp-screencast"
          ? "CDP"
          : "fallback";
  const summaryFrame = video.front?.frame ?? currentFrame;
  const frameSummary = summaryFrame
    ? layout.compact
      ? `${summaryFrame.width}×${summaryFrame.height} · ${transportLabel}`
      : `${summaryFrame.width} × ${summaryFrame.height} · ${Math.ceil((video.front ? (video.front.dataBase64.length * 3) / 4 : (frame?.byteLength ?? 0)) / BYTES_PER_KIBIBYTE)} KB · ${transportLabel} · ${deviceLabel}`
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
    <View
      ref={paneRef}
      collapsable={false}
      style={styles.screen}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setPaneSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }}
    >
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
            dimWhenReadOnly={false}
            keyboardType="url"
            maxLength={MAX_URL_LENGTH}
            returnKeyType="go"
            style={[styles.addressInput, styles.chromeAddressInput]}
            onChangeText={setAddressDraft}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            onSubmit={() => navigate("goto", addressDraft)}
          />
          <View ref={displayAnchorRef} collapsable={false}>
            <ChromeIconButton
              styles={styles}
              theme={theme}
              label="Display options"
              icon="Monitor"
              selected={toolbarMenu === "display"}
              expanded={toolbarMenu === "display"}
              onPress={() => toggleToolbarMenu("display")}
            />
          </View>
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label={`${emulation.mode === "mobile" ? "Disable" : "Enable"} mobile emulation`}
            icon="Smartphone"
            selected={emulation.mode === "mobile"}
            disabled={!canControl || anyMutationPending}
            onPress={emulation.toggle}
          />
          <View ref={actionsAnchorRef} collapsable={false}>
            <ChromeIconButton
              styles={styles}
              theme={theme}
              label="Browser menu"
              icon="EllipsisVertical"
              selected={toolbarMenu === "actions"}
              expanded={toolbarMenu === "actions"}
              onPress={() => toggleToolbarMenu("actions")}
            />
          </View>
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

      {runtimeNotice || visibleError || state?.notice ? (
        <ErrorNotice
          styles={styles}
          theme={theme}
          message={runtimeNotice ?? visibleError ?? state?.notice ?? ""}
          action={connectionError || reconnecting ? "Reconnect" : undefined}
          onAction={connectionError || reconnecting ? reconnect : undefined}
          actionDisabled={attachQuery.isFetching}
        />
      ) : null}

      <View style={styles.canvasShell}>
        <BrowserCanvasViewport
          mode={scaleMode}
          style={styles.canvas}
          contentSize={canvasLayout?.contentSize ?? containerSize}
          localPanEnabled={layout.platform === "web" || !canControl}
          onLayout={handleCanvasLayout}
        >
          {buffer.layers.map((layer, slot) => {
            if (!layer) return null;
            const rect = getBrowserCanvasLayout(
              containerSize,
              layer.candidate.frame,
              layer.candidate.viewport ?? state?.viewport ?? layer.candidate.frame,
              scaleMode,
            )?.frameRect;
            if (!rect) return null;
            const visible = slot === buffer.front;
            return (
              <BrowserFrameImage
                key={layer.ticket}
                ticket={layer.ticket}
                visible={visible}
                label={state?.title ? `Shared browser: ${state.title}` : "Shared browser frame"}
                settled={settled}
                retry={retryFrameCapture}
                source={layer.source}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                cornerRadius={layout.compact ? DIMENSION.screenRadius - SPACE.xs : 0}
              />
            );
          })}
          {video.supported ? (
            <BrowserVideoSurface
              canvasRef={video.canvasRef}
              style={{
                position: "absolute",
                left: displayRect?.x ?? 0,
                top: displayRect?.y ?? 0,
                width: displayRect?.width ?? containerSize.width,
                height: displayRect?.height ?? containerSize.height,
                opacity: video.front ? 1 : 0,
                overflow: "hidden",
                borderRadius: layout.compact ? DIMENSION.screenRadius - SPACE.xs : 0,
              }}
            />
          ) : null}
          {currentFrame && displayRect ? (
            <View
              ref={canvasInput.canvasRef}
              {...canvasInput.panHandlers}
              accessible={false}
              pointerEvents={liveInputEnabled ? "auto" : "none"}
              style={interactionStyle}
            />
          ) : video.front ? null : imageError ? (
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
          ) : state?.recoveryState === "runtime-unavailable" || state?.status === "error" ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Browser unavailable"
              detail={state.error ?? "The browser runtime is temporarily unavailable."}
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
        </BrowserCanvasViewport>
        <View style={styles.canvasFooter}>
          <Text numberOfLines={1} style={styles.canvasFooterText}>
            {state?.title || state?.url || "Shared browser"}
          </Text>
          <Text numberOfLines={1} style={styles.canvasFooterText}>
            {frameSummary}
          </Text>
        </View>
      </View>

      <ComposeTextControls
        styles={styles}
        theme={theme}
        composeText={canvasInput.composeText}
        cancelInput={canvasInput.cancel}
        enabled={canSendInput}
        ownershipKey={composeOwnershipKey}
        request={composeRequest}
        onRequestHandled={composeRequestHandled}
      />

      <Modal
        title="Resolution and quality"
        icon={<Icon name="Smartphone" size={18} color={theme.colors.foreground} />}
        open={devicePickerOpen}
        onOpenChange={setDevicePickerOpen}
      >
        <Modal.Content>
          <View style={styles.deviceModalContent}>
            <BrowserResolutionPicker
              theme={theme}
              groups={groupResolutionPresets()}
              selectedPresetId={selectedResolutionPresetId}
              favoritePresetIds={preferences.favoritePresetIds}
              selectDisabled={!canControl || anyMutationPending}
              favoriteDisabled={preferences.disabled}
              density={state?.captureScale ?? 1}
              viewport={state?.viewport ?? null}
              onDensityChange={(density) => {
                if (!requireControlContext() || anyMutationPending) return;
                densityControl.select(density);
              }}
              captureQuality={preferences.captureQuality}
              videoBitrate={preferences.videoBitrate}
              videoFps={preferences.videoFps}
              onVideoBitrateChange={preferences.changeVideoBitrate}
              onVideoFpsChange={preferences.changeVideoFps}
              onSelect={selectDevicePreset}
              onToggleFavorite={(id) => {
                void preferences.toggleFavorite(id);
              }}
              onQualityChange={(quality) => {
                void preferences.changeQuality(quality);
              }}
            />
            {preferences.error ? (
              <View style={styles.controlStrip}>
                <Text accessibilityRole="alert" style={styles.mutedText}>
                  {preferences.error}
                </Text>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Reload preferences"
                  onPress={preferences.reload}
                />
              </View>
            ) : null}
            <Text style={styles.stripLabel}>Custom viewport</Text>
            {visibleError ? (
              <ErrorNotice styles={styles} theme={theme} message={visibleError} />
            ) : null}
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
      {toolbarMenu ? (
        <BrowserToolbarMenu
          key={toolbarMenu}
          theme={theme}
          compact={layout.compact}
          title={toolbarMenu === "display" ? "Display options" : "Browser menu"}
          paneRef={paneRef}
          paneSize={paneSize}
          anchorRef={toolbarMenu === "display" ? displayAnchorRef : actionsAnchorRef}
          preferredHeight={
            toolbarMenu === "display"
              ? 300 + preferences.favoritePresetIds.length * (layout.compact ? 44 : 36)
              : layout.platform === "web"
                ? 88
                : 176
          }
          onClose={() => closeToolbarMenu()}
          shouldRestoreFocus={() => menuRestoreFocus.current}
          onSubmenuOpen={() => {
            if (canSendInput) setKeysSubmenuOpen(true);
          }}
          submenu={
            toolbarMenu === "actions" && keysSubmenuOpen
              ? {
                  title: "Send keys",
                  anchorRef: keysAnchorRef,
                  preferredHeight: 40 + SPECIAL_KEYS.length * (layout.compact ? 44 : 36),
                  onBack: () => setKeysSubmenuOpen(false),
                  children: SPECIAL_KEYS.map(({ key, label }) => (
                    <BrowserMenuItem
                      key={key}
                      theme={theme}
                      compact={layout.compact}
                      label={label}
                      disabled={!canSendInput}
                      onPress={() => {
                        sendEvent({ kind: "key", key });
                      }}
                    />
                  )),
                }
              : undefined
          }
        >
          {toolbarMenu === "display" ? (
            <>
              <BrowserMenuHeading theme={theme}>View size</BrowserMenuHeading>
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Fit to panel"
                icon="Minimize"
                selected={scaleMode === "fit"}
                onPress={() => {
                  closeToolbarMenu();
                  setScaleMode("fit");
                }}
              />
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Actual size (100%)"
                icon="Maximize"
                selected={scaleMode === "actual"}
                onPress={() => {
                  closeToolbarMenu();
                  setScaleMode("actual");
                }}
              />
              {layout.platform !== "web" && scaleMode === "actual" ? (
                <Text
                  style={[styles.devicePresetDetail, { paddingHorizontal: 12, paddingVertical: 4 }]}
                >
                  Release control to pan this view. While controlling, swipes go to the page.
                </Text>
              ) : null}
              <BrowserMenuSeparator theme={theme} />
              <BrowserMenuHeading theme={theme}>Favorite resolutions</BrowserMenuHeading>
              {preferences.favoritePresetIds.length === 0 ? (
                <Text
                  style={[styles.devicePresetDetail, { paddingHorizontal: 12, paddingVertical: 4 }]}
                >
                  Star resolutions in the full list to add them here.
                </Text>
              ) : (
                preferences.favoritePresetIds.map((id) => {
                  const preset = DEVICE_PRESETS.find((item) => item.id === id);
                  return preset ? (
                    <BrowserMenuItem
                      key={id}
                      theme={theme}
                      compact={layout.compact}
                      label={preset.label}
                      icon={preset.isMobile ? "Smartphone" : "Monitor"}
                      selected={selectedResolutionPresetId === id}
                      disabled={!canControl || anyMutationPending}
                      onPress={() => {
                        closeToolbarMenu();
                        selectDevicePreset(id);
                      }}
                    />
                  ) : null;
                })
              )}
              <BrowserMenuSeparator theme={theme} />
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="All resolutions and quality"
                icon="Settings2"
                onPress={() => {
                  closeToolbarMenu(false);
                  setDevicePickerOpen(true);
                }}
              />
            </>
          ) : (
            <>
              {layout.platform !== "web" || layout.compact ? (
                <BrowserMenuItem
                  theme={theme}
                  compact={layout.compact}
                  label="Compose text"
                  icon="Pencil"
                  disabled={!canSendInput}
                  onPress={requestCompose}
                />
              ) : null}
              <View ref={keysAnchorRef}>
                <BrowserMenuItem
                  theme={theme}
                  compact={layout.compact}
                  label="Send keys"
                  icon="Keyboard"
                  expanded={keysSubmenuOpen}
                  disabled={!canSendInput}
                  onPress={() => setKeysSubmenuOpen(true)}
                />
              </View>
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Reconnect viewer"
                icon="RotateCw"
                disabled={attachQuery.isFetching}
                onPress={() => {
                  closeToolbarMenu();
                  reconnect();
                }}
              />
            </>
          )}
        </BrowserToolbarMenu>
      ) : null}
    </View>
  );
}
