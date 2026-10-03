import type { BrowserFrame } from "../shared/browser";

/**
 * Tracks which captured frame input may target. After an input is submitted
 * and again when it settles, the actionable frame is dropped and the epoch
 * advances, so captures that began earlier are ignored. Input stays blocked
 * until a capture taken after settlement is accepted. The last accepted image
 * stays visible meanwhile.
 */
export class FrameLifecycle {
  epoch = 0;
  /** Frame input may target; null while a fresh capture is awaited. */
  frame: BrowserFrame | null = null;
  /** Last accepted frame, kept on screen while input is blocked. */
  visible: BrowserFrame | null = null;
  private gate: "idle" | "pending" | "refreshing" = "idle";

  get busy(): boolean {
    return this.gate !== "idle";
  }

  bump(): void {
    this.epoch += 1;
  }

  isCurrent(captureEpoch: number): boolean {
    return captureEpoch === this.epoch;
  }

  /** Claims the input slot; false if an input is already in flight or awaiting a fresh frame. */
  begin(): boolean {
    if (this.busy) return false;
    this.gate = "pending";
    this.frame = null;
    this.bump();
    return true;
  }

  /** Called when an input succeeds or fails. Never replays the action. */
  settle(): void {
    this.frame = null;
    this.bump();
    this.gate = "refreshing";
  }

  /** Accepts a capture started at `captureEpoch`; false if it predates the latest boundary. */
  accept(captureEpoch: number, frame: BrowserFrame): boolean {
    if (!this.isCurrent(captureEpoch)) return false;
    this.frame = frame;
    this.visible = frame;
    if (this.gate === "refreshing") this.gate = "idle";
    return true;
  }

  /** Forgets all frames, e.g. when the session no longer matches them. */
  drop(): void {
    this.frame = null;
    this.visible = null;
  }

  reset(): void {
    this.drop();
    this.gate = "idle";
  }
}
