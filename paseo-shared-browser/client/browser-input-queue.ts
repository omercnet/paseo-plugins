/**
 * Ordered, bounded live browser input. A channel starts from decoded front-frame
 * authority; its own motion continues with opaque server identity/sequence. Only
 * replaceable motion with unchanged pressed identities and wheel deltas coalesce.
 * Press/release and touch identity changes remain ordered. No uncertain mutation is replayed.
 */
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  BrowserCursor,
  BrowserGestureEvent,
  BrowserState,
  beginBrowserGestureRpc,
  endBrowserGestureRpc,
  updateBrowserGestureRpc,
} from "../shared/browser";

export type BrowserGestureAuthority = Omit<RpcInput<typeof beginBrowserGestureRpc>, "pointerKind">;
export type BrowserGesturePoint = Extract<BrowserGestureEvent, { kind: "move" }>["point"];
export type BrowserTouchPoint = Extract<BrowserGestureEvent, { kind: "touch" }>["points"][number];
/** Preserve the admission union while using schema-normalized state defaults. */
type NormalizedAdmission<T> = T extends unknown
  ? Omit<T, "state"> & { state: BrowserState }
  : never;
export interface BrowserGestureTransport {
  begin(
    input: RpcInput<typeof beginBrowserGestureRpc>,
  ): Promise<NormalizedAdmission<RpcOutput<typeof beginBrowserGestureRpc>>>;
  update(input: RpcInput<typeof updateBrowserGestureRpc>): Promise<
    Omit<RpcOutput<typeof updateBrowserGestureRpc>, "state"> & {
      state: BrowserState;
    }
  >;
  end(input: RpcInput<typeof endBrowserGestureRpc>): Promise<
    Omit<RpcOutput<typeof endBrowserGestureRpc>, "state"> & {
      state: BrowserState;
    }
  >;
}
interface QueueOptions {
  transport: BrowserGestureTransport;
  authority(): BrowserGestureAuthority | null;
  onState(state: BrowserState): void;
  onCursor(cursor: BrowserCursor | null): void;
  onError(error: unknown): void;
  onFinish(): void;
  /** Reset local held contacts after an acknowledged navigation, without cancelling this queue again. */
  onNavigationComplete?(): void;
  /** Resolves only after a different decoded front frame commits, not after a timer. */
  waitForFrame?(afterFrameId: string, maxWaitMs?: number): Promise<void>;
}
type Command = { event: BrowserGestureEvent } | { end: true };
interface Channel {
  authority: BrowserGestureAuthority;
  pointerKind: "mouse" | "touch";
  gestureId: string;
  sequence: number;
  heldButtons: Set<string>;
  heldKeys: Set<string>;
  touchCount: number;
}
const MAX_QUEUED_COMMANDS = 64;
const MAX_WHEEL_DELTA = 4_000;
const MAX_FRAME_ADMISSION_ATTEMPTS = 3;
const FRAME_ADMISSION_WAIT_MS = 4_000;

/** Compare control/route incarnation, never the changing decoded frame identity. */
function sameAuthority(a: BrowserGestureAuthority, b: BrowserGestureAuthority | null): boolean {
  return Boolean(
    b &&
      a.viewerToken === b.viewerToken &&
      a.controlToken === b.controlToken &&
      a.expected.sessionId === b.expected.sessionId &&
      a.expected.runtimeId === b.expected.runtimeId &&
      a.expected.bridgeEpoch === b.expected.bridgeEpoch &&
      a.expected.navigationGeneration === b.expected.navigationGeneration &&
      a.expected.viewportGeneration === b.expected.viewportGeneration,
  );
}
function transportContext(authority: BrowserGestureAuthority) {
  return {
    viewerToken: authority.viewerToken,
    controlToken: authority.controlToken,
    expected: authority.expected,
  };
}
function needsFreshPress(event: BrowserGestureEvent, channel: Channel): boolean {
  return (
    event.kind === "down" ||
    (event.kind === "touch" && event.type === "start" && channel.touchCount === 0)
  );
}

/** A qualified reply completes old input; it never authorizes input on the new page. */
function isAcknowledgedNavigation(original: BrowserGestureAuthority, state: BrowserState): boolean {
  return (
    state.status === "ready" &&
    state.controller === "self" &&
    state.sessionId === original.expected.sessionId &&
    state.runtimeId === original.expected.runtimeId &&
    state.bridgeEpoch === original.expected.bridgeEpoch &&
    state.viewportGeneration === original.expected.viewportGeneration &&
    state.navigationGeneration > original.expected.navigationGeneration
  );
}

/** One in-flight RPC, with fail-closed cancellation on pressure or authority loss. */
export function createBrowserInputQueue(options: QueueOptions) {
  let epoch = 0;
  let running = false;
  let channel: Channel | null = null;
  let commands: Command[] = [];
  let invalidatedFrameId: string | null = null;

  const cancelChannel = async (old: Channel) => {
    try {
      await options.transport.end({
        ...transportContext(old.authority),
        gestureId: old.gestureId,
        sequence: old.sequence,
        cancel: true,
      });
    } catch {
      // Best-effort cleanup, never retry physical input. Server's bounded idle
      // expiry releases an uncertain channel if the cleanup reply is lost.
    }
  };
  const cancel = () => {
    epoch += 1;
    commands = [];
    invalidatedFrameId = null;
    const old = channel;
    channel = null;
    options.onCursor(null);
    if (old && !running) void cancelChannel(old);
  };

  const drain = async () => {
    if (running) return;
    running = true;
    const currentEpoch = epoch;
    let owned = channel;
    try {
      while (commands.length && currentEpoch === epoch) {
        const command = commands.shift();
        if (!command) break;
        if ("end" in command) {
          if (!owned) continue;
          // A pointer release must not release a still-held keyboard chord.
          if (owned.heldKeys.size || owned.heldButtons.size || owned.touchCount) continue;
          const ending = owned;
          const result = await options.transport.end({
            ...transportContext(ending.authority),
            gestureId: ending.gestureId,
            sequence: ending.sequence,
            cancel: false,
          });
          owned = null;
          channel = null;
          if (currentEpoch !== epoch || !sameAuthority(ending.authority, options.authority()))
            break;
          options.onState(result.state);
          if (!sameAuthority(ending.authority, options.authority())) {
            throw new Error("Browser input context changed. Release the gesture and try again.");
          }
          // Normal channel completion keeps the last qualified hover cursor.
          // A null end receipt denotes cleanup, not a new pointer location.
          if (result.cursor !== null) options.onCursor(result.cursor);
          options.onFinish();
          continue;
        }

        let current = options.authority();
        if (!current) throw new Error("A decoded frame and active browser control are required.");
        const pointerKind =
          command.event.kind === "touch"
            ? "touch"
            : command.event.kind === "key" || command.event.kind === "text"
              ? (owned?.pointerKind ?? "mouse")
              : "mouse";
        if (owned && !sameAuthority(owned.authority, current)) {
          throw new Error("Browser input context changed. Release the gesture and try again.");
        }
        if (owned && owned.pointerKind !== pointerKind) {
          // Changing input devices is ordinary on touch laptops. Close only this
          // exact old channel before sending the still-unsent event on a new one.
          await cancelChannel(owned);
          owned = null;
          channel = null;
          if (currentEpoch !== epoch) break;
          if (!sameAuthority(current, options.authority())) {
            throw new Error("Browser input context changed. Release the gesture and try again.");
          }
        }
        if (!owned) {
          const admissionDeadline = Date.now() + FRAME_ADMISSION_WAIT_MS;
          if (invalidatedFrameId === current.target.frameId && options.waitForFrame) {
            const waitingAuthority = current;
            await options.waitForFrame(current.target.frameId, FRAME_ADMISSION_WAIT_MS);
            if (currentEpoch !== epoch) break;
            current = options.authority();
            if (!sameAuthority(waitingAuthority, current)) break;
            if (!current) throw new Error("Browser input context changed.");
          }
          for (let attempt = 0; attempt < MAX_FRAME_ADMISSION_ATTEMPTS; attempt += 1) {
            if (Date.now() >= admissionDeadline) break;
            const sentAuthority = current;
            const result = await options.transport.begin({ ...sentAuthority, pointerKind });
            if (!("admission" in result)) {
              owned = {
                authority: sentAuthority,
                pointerKind,
                gestureId: result.gestureId,
                sequence: result.nextSequence,
                heldButtons: new Set(),
                heldKeys: new Set(),
                touchCount: 0,
              };
            }
            if (currentEpoch !== epoch || !sameAuthority(sentAuthority, options.authority())) break;
            options.onState(result.state);
            if (!sameAuthority(sentAuthority, options.authority())) break;
            if (owned) {
              channel = owned;
              break;
            }
            // Only this validated non-publication receipt permits another begin.
            // A runtime/transport exception never retries an action. Captures
            // already decoding may also be revoked, so admission remains bounded.
            if (attempt === MAX_FRAME_ADMISSION_ATTEMPTS - 1) break;
            options.onFinish();
            const latest = options.authority();
            if (latest?.target.frameId === sentAuthority.target.frameId) {
              if (!options.waitForFrame) throw new Error("Waiting for a current decoded frame.");
              const remaining = admissionDeadline - Date.now();
              if (remaining <= 0) break;
              await options.waitForFrame(sentAuthority.target.frameId, remaining);
            }
            if (currentEpoch !== epoch) break;
            current = options.authority();
            if (!current || !sameAuthority(sentAuthority, current)) {
              throw new Error("Browser input context changed. Release the gesture and try again.");
            }
          }
          if (currentEpoch !== epoch || !sameAuthority(current, options.authority())) break;
          if (!owned)
            throw new Error(
              "Waiting for a current decoded frame. Release the gesture and try again.",
            );
        }

        let fresh = options.authority();
        if (
          needsFreshPress(command.event, owned) &&
          fresh &&
          invalidatedFrameId === fresh.target.frameId &&
          options.waitForFrame
        ) {
          await options.waitForFrame(fresh.target.frameId);
          if (currentEpoch !== epoch) break;
          fresh = options.authority();
        }
        if (!sameAuthority(owned.authority, fresh)) {
          throw new Error("Browser input context changed. Release the gesture and try again.");
        }
        if (
          (command.event.kind !== "move" && command.event.kind !== "leave") ||
          owned.heldButtons.size > 0
        ) {
          invalidatedFrameId = fresh?.target.frameId ?? null;
        }
        const requiresTarget = needsFreshPress(command.event, owned);
        if (command.event.kind === "key" && command.event.type === "down")
          owned.heldKeys.add(command.event.code);
        if (command.event.kind === "key" && command.event.type === "up")
          owned.heldKeys.delete(command.event.code);
        if (command.event.kind === "touch") owned.touchCount = command.event.points.length;
        if (command.event.kind === "down") owned.heldButtons.add(command.event.button);
        if (command.event.kind === "up") owned.heldButtons.delete(command.event.button);
        const expectedNextSequence = owned.sequence + 1;
        const result = await options.transport.update({
          ...transportContext(owned.authority),
          gestureId: owned.gestureId,
          sequence: owned.sequence,
          event: command.event,
          ...(requiresTarget && fresh ? { target: fresh.target } : {}),
        });
        owned.sequence = result.nextSequence;
        if (currentEpoch !== epoch || !sameAuthority(owned.authority, options.authority())) break;
        if (result.gestureId !== owned.gestureId)
          throw new Error("Browser gesture identity changed.");
        if (result.completion === "navigation") {
          if (
            !isAcknowledgedNavigation(owned.authority, result.state) ||
            result.nextSequence !== expectedNextSequence
          ) {
            throw new Error("Browser navigation completion identity changed.");
          }
          // Native publication and cleanup are already acknowledged. Discard
          // queued releases/typing from the old document before projecting the
          // new state, which intentionally invalidates the old decoded frame.
          epoch += 1;
          commands = [];
          invalidatedFrameId = null;
          channel = null;
          owned = null;
          options.onCursor(null);
          options.onNavigationComplete?.();
          options.onState(result.state);
          options.onFinish();
          break;
        }
        options.onState(result.state);
        if (!sameAuthority(owned.authority, options.authority())) {
          throw new Error("Browser input context changed. Release the gesture and try again.");
        }
        options.onCursor(result.cursor);
      }
    } catch (error) {
      if (currentEpoch === epoch) {
        epoch += 1;
        commands = [];
        channel = null;
        options.onCursor(null);
        options.onError(error);
      }
    } finally {
      if (
        owned &&
        (currentEpoch !== epoch || !sameAuthority(owned.authority, options.authority()))
      ) {
        if (currentEpoch === epoch) {
          epoch += 1;
          commands = [];
          options.onCursor(null);
        }
        await cancelChannel(owned);
        if (channel === owned) channel = null;
      }
      running = false;
      if (commands.length) void drain();
    }
  };

  const enqueue = (event: BrowserGestureEvent) => {
    if (!options.authority()) return false;
    // Keep leave behind the queued release, ahead of normal channel cleanup.
    const trailing = commands.at(-1);
    if (event.kind === "leave" && trailing && "end" in trailing) commands.pop();
    const previous = commands.at(-1);
    if (previous && "event" in previous) {
      if (event.kind === "move" && previous.event.kind === "move") {
        previous.event = event;
        return true;
      }
      if (
        event.kind === "touch" &&
        previous.event.kind === "touch" &&
        event.type === "move" &&
        previous.event.type === "move" &&
        event.points.length === previous.event.points.length &&
        event.points.every(
          (point) =>
            previous.event.kind === "touch" &&
            previous.event.points.some((other) => other.id === point.id),
        )
      ) {
        previous.event = event;
        return true;
      }
      if (event.kind === "scroll" && previous.event.kind === "scroll") {
        const deltaX = previous.event.deltaX + event.deltaX;
        const deltaY = previous.event.deltaY + event.deltaY;
        if (Math.abs(deltaX) <= MAX_WHEEL_DELTA && Math.abs(deltaY) <= MAX_WHEEL_DELTA) {
          previous.event = { ...event, deltaX, deltaY };
          return true;
        }
      }
    }
    if (commands.length >= MAX_QUEUED_COMMANDS) {
      cancel();
      options.onError(
        new Error("Browser input cannot keep up. Release the gesture and try again."),
      );
      return false;
    }
    commands.push({ event });
    void drain();
    return true;
  };
  const finish = () => {
    const last = commands.at(-1);
    if (last && "end" in last) return;
    commands.push({ end: true });
    void drain();
  };

  return { enqueue, finish, cancel };
}
