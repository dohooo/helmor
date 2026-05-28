// Shell-wide constants. Centralised so magic numbers stay named and so
// stable empty fallbacks share referential identity across renders.
import type { ActiveStreamSummary } from "@/lib/api";
import type { SessionRunState } from "@/lib/session-run-state";

export const EMPTY_SESSION_RUN_STATES: ReadonlyMap<string, SessionRunState> =
	new Map();
export const EMPTY_STRING_LIST: readonly string[] = [];
export const EMPTY_ACTIVE_STREAMS: readonly ActiveStreamSummary[] = [];

// Splash boot timing — keeps the splash up for `MIN_DURATION_MS` even if
// settings load instantly, then fades out over `FADE_MS` before unmounting.
export const SPLASH_MIN_DURATION_MS = 1000;
export const SPLASH_FADE_MS = 400;
export const SPLASH_POST_ONBOARDING_DELAY_MS = 1000;

// `processPendingCliSends` queues the prompt one tick after selecting the
// session so React can commit the selection before the composer wakes up.
export const CLI_SEND_AUTO_SUBMIT_DELAY_MS = 100;

// Workspace background warmup — staggered to avoid jamming the SQLite
// reader queue during startup.
export const WORKSPACE_WARMUP_INITIAL_DELAY_MS = 400;
export const WORKSPACE_WARMUP_STEP_DELAY_MS = 150;
export const WORKSPACE_WARMUP_MAX_COUNT = 4;

// Recently-closed-session ring buffer for the "reopen closed session" shortcut.
export const RECENTLY_CLOSED_SESSIONS_MAX = 20;
// Per-workspace session-selection history depth (LIFO) for restoring the
// last viewed session when re-entering a workspace.
export const SESSION_SELECTION_HISTORY_MAX = 16;
