/**
 * Recover viewing after its short-lived viewer token expires during background
 * suspension. Only a viewing read (capture, video or the tab list poll) can use this
 * policy; mutation failure must never trigger action replay, control acquisition or
 * lease takeover.
 */
const VIEWER_EXPIRED_MESSAGE = "Viewer token is invalid or expired";
const BROWSER_CLOSED_MESSAGE = "Browser is closed";
const BROWSER_TAB_UNAVAILABLE_MESSAGE = "Browser tab is no longer available";
// The supervisor wraps runtime rejections as "Workspace runtime <operation> failed: <message>".
const UNAVAILABLE_TAB_PATTERN = new RegExp(
  `^(?:Workspace runtime \\w+ failed: )?${BROWSER_TAB_UNAVAILABLE_MESSAGE}(?: requestType=|$)`,
);

/** Recognize the server's explicit close fence without confusing it with a transport failure. */
export function isBrowserClosedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { message?: unknown; code?: unknown };
  if (typeof value.message !== "string") return false;
  if (value.code !== undefined && value.code !== "handler_error") return false;
  const message = value.message.startsWith("Request failed: ")
    ? value.message.slice("Request failed: ".length)
    : value.message;
  return (
    message === BROWSER_CLOSED_MESSAGE ||
    (value.code === "handler_error" && message.startsWith(`${BROWSER_CLOSED_MESSAGE} requestType=`))
  );
}

/** Match the owned handler error, including Paseo's documented RPC error suffix. */
export function isExpiredBrowserViewerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { message?: unknown; code?: unknown };
  if (typeof value.message !== "string") return false;
  if (value.code !== undefined && value.code !== "handler_error") return false;
  // Daemon session.js applies this exact prefix before the client appends
  // requestType/code. Arbitrary error text never grants automatic recovery.
  const message =
    value.code === "handler_error" && value.message.startsWith("Request failed: ")
      ? value.message.slice("Request failed: ".length)
      : value.message;
  if (message === VIEWER_EXPIRED_MESSAGE) return true;
  return (
    value.code === "handler_error" && message.startsWith(`${VIEWER_EXPIRED_MESSAGE} requestType=`)
  );
}

export interface BrowserViewerRecoveryObservation {
  /** Host/workspace scope of the mounted panel, never a printer or page identity. */
  identity: string;
  viewerToken: string | null;
  /** Exact token of the failed capture query or video reader; an old viewer cannot recover its replacement. */
  failedViewerToken: string | null;
  captureError: unknown;
  pending: boolean;
}

export interface BrowserViewingFailures {
  viewerToken: string | null;
  /** The video reader reports the exact token it failed with. */
  video: { error: unknown; viewerToken: string | null };
  /** Capture and tab list queries are keyed to the current viewer token. */
  captureError: unknown;
  tabsError: unknown;
}

/**
 * Pick the viewing failure that may claim recovery. Video and capture keep their
 * priority; an expired tab poll also qualifies, so a panel whose only live read is
 * the tab list reattaches once instead of polling a dead token forever.
 */
export function selectViewerRecoveryFailure(
  failures: BrowserViewingFailures,
): Pick<BrowserViewerRecoveryObservation, "failedViewerToken" | "captureError"> {
  const { viewerToken, video, captureError, tabsError } = failures;
  if (video.viewerToken === viewerToken && isExpiredBrowserViewerError(video.error))
    return { failedViewerToken: video.viewerToken, captureError: video.error };
  if (!isExpiredBrowserViewerError(captureError) && isExpiredBrowserViewerError(tabsError))
    return { failedViewerToken: viewerToken, captureError: tabsError };
  return { failedViewerToken: viewerToken, captureError };
}

const TABS_POLL_MS = 2_000;
/** React Query's default retry budget, kept for every failure except an expired viewer. */
const TABS_RETRY_LIMIT = 3;

/** An expired viewer token never becomes valid again; stop polling it and let recovery reattach. */
export function browserTabsRefetchInterval(error: unknown): number | false {
  return isExpiredBrowserViewerError(error) ? false : TABS_POLL_MS;
}

export function shouldRetryBrowserTabs(failureCount: number, error: unknown): boolean {
  return !isExpiredBrowserViewerError(error) && failureCount < TABS_RETRY_LIMIT;
}

/**
 * Claim at most one automatic viewing reattachment per expired token. Failure
 * keeps manual Reconnect available. A new token or panel scope permits its own
 * later recovery; this helper neither issues input nor holds browser authority.
 */
export function createBrowserViewerRecovery() {
  let scope: string | null = null;
  let attemptedToken: string | null = null;
  return (observation: BrowserViewerRecoveryObservation): boolean => {
    if (scope !== observation.identity) {
      scope = observation.identity;
      attemptedToken = null;
    }
    const token = observation.viewerToken;
    if (
      observation.pending ||
      !token ||
      observation.failedViewerToken !== token ||
      attemptedToken === token ||
      !isExpiredBrowserViewerError(observation.captureError)
    ) {
      return false;
    }
    attemptedToken = token;
    return true;
  };
}

/**
 * A remembered tab can outlive its page; the server then rejects attaching to it. The runtime
 * wraps that rejection ("Workspace runtime identity failed: ..."), so match the phrase.
 */
export function isBrowserTabUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { message?: unknown; code?: unknown };
  if (typeof value.message !== "string") return false;
  if (value.code !== undefined && value.code !== "handler_error") return false;
  const message = value.message.startsWith("Request failed: ")
    ? value.message.slice("Request failed: ".length)
    : value.message;
  return UNAVAILABLE_TAB_PATTERN.test(message);
}
