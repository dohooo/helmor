/**
 * Schedule `task` for the macrotask right after the next paint:
 * `requestAnimationFrame` (pre-paint) → `setTimeout(0)` (post-paint), raced
 * against a fallback timer. The fallback exists because WKWebView suspends
 * rAF entirely while the window is occluded (repo precedent: commit
 * 7a620500); it is deliberately long so that under heavy-but-visible
 * main-thread load the paint path almost always wins — a short fallback
 * would fire before the starved rendering update and merge the deferred
 * work back into the input task's frame.
 *
 * Exactly-once across both paths (and `flush`) via `consumed`; all three
 * handles are cleared by whichever path runs first.
 */
export const SCHEDULE_AFTER_PAINT_FALLBACK_MS = 250;

export interface ScheduledAfterPaint {
	/** Run the task immediately if it hasn't run yet (cancels the timers). */
	flush: () => void;
	/** Drop the task without running it. */
	cancel: () => void;
}

export function scheduleAfterNextPaint(
	task: () => void,
	fallbackMs: number = SCHEDULE_AFTER_PAINT_FALLBACK_MS,
): ScheduledAfterPaint {
	let consumed = false;
	let rafId: number | null = null;
	let innerTimerId: number | null = null;
	let fallbackTimerId: number | null = null;

	const clearHandles = () => {
		if (rafId !== null) cancelAnimationFrame(rafId);
		if (innerTimerId !== null) window.clearTimeout(innerTimerId);
		if (fallbackTimerId !== null) window.clearTimeout(fallbackTimerId);
		rafId = null;
		innerTimerId = null;
		fallbackTimerId = null;
	};

	const run = () => {
		if (consumed) return;
		consumed = true;
		clearHandles();
		task();
	};

	rafId = requestAnimationFrame(() => {
		rafId = null;
		innerTimerId = window.setTimeout(run, 0);
	});
	fallbackTimerId = window.setTimeout(run, fallbackMs);

	return {
		flush: run,
		cancel: () => {
			consumed = true;
			clearHandles();
		},
	};
}
