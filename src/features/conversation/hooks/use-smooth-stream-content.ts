// Smooths bursty agent SDK deltas into a steady character-per-frame reveal.
// Vendored from lobe-ui (src/Markdown/SyntaxMarkdown/useSmoothStreamContent.ts,
// MIT); profiler hooks + multi-preset API stripped — single helmor-tuned
// config below: deeper buffer + tighter output ceilings to absorb sidecar
// adapter jitter while staying steady when the model pauses.

import { useCallback, useEffect, useRef, useState } from "react";

const CONFIG = {
	activeInputWindowMs: 380,
	defaultCps: 26,
	emaAlpha: 0.12,
	flushCps: 64,
	largeAppendChars: 140,
	maxActiveCps: 56,
	maxCps: 44,
	maxFlushCps: 96,
	minCps: 12,
	settleAfterMs: 520,
	settleDrainMaxMs: 900,
	settleDrainMinMs: 300,
	targetBufferMs: 1000,
};

const clamp = (value: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, value));

const getNow = () =>
	typeof performance === "undefined" ? Date.now() : performance.now();

// Don't park the smoothed prefix on a markdown marker char — the literal
// symbol would otherwise hang in the DOM until the closing token arrives.
const MAX_MARKER_LOOKAHEAD = 16;

const isMarkdownMarkerChar = (ch: string): boolean => {
	switch (ch.charCodeAt(0)) {
		case 0x21: // !
		case 0x24: // $
		case 0x28: // (
		case 0x29: // )
		case 0x2a: // *
		case 0x3c: // <
		case 0x3e: // >
		case 0x5b: // [
		case 0x5c: // \
		case 0x5d: // ]
		case 0x5f: // _
		case 0x60: // `
		case 0x7c: // |
		case 0x7e: // ~
			return true;
		default:
			return false;
	}
};

interface UseSmoothStreamContentOptions {
	enabled?: boolean;
}

export const useSmoothStreamContent = (
	content: string,
	{ enabled = true }: UseSmoothStreamContentOptions = {},
): string => {
	const config = CONFIG;
	const [displayedContent, setDisplayedContent] = useState(content);

	const displayedContentRef = useRef(content);
	// Char-array refs are populated lazily on the first enabled render so a
	// historical mount doesn't pay O(n) codepoint splits it'll never use.
	const displayedCountRef = useRef(0);

	const targetContentRef = useRef(content);
	const targetCharsRef = useRef<string[]>([]);
	const targetCountRef = useRef(0);
	const initializedRef = useRef(false);

	const emaCpsRef = useRef(config.defaultCps);
	const lastInputTsRef = useRef(0);
	const lastInputCountRef = useRef(0);
	const chunkSizeEmaRef = useRef(1);
	const arrivalCpsEmaRef = useRef(config.defaultCps);

	const ensureInitialized = useCallback((seed: string) => {
		if (initializedRef.current) return;
		initializedRef.current = true;
		const chars = [...seed];
		targetCharsRef.current = chars;
		targetCountRef.current = chars.length;
		displayedCountRef.current = chars.length;
		lastInputCountRef.current = chars.length;
	}, []);

	const rafRef = useRef<number | null>(null);
	const lastFrameTsRef = useRef<number | null>(null);
	const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearWakeTimer = useCallback(() => {
		if (wakeTimerRef.current !== null) {
			clearTimeout(wakeTimerRef.current);
			wakeTimerRef.current = null;
		}
	}, []);

	const stopFrameLoop = useCallback(() => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		lastFrameTsRef.current = null;
	}, []);

	const stopScheduling = useCallback(() => {
		stopFrameLoop();
		clearWakeTimer();
	}, [clearWakeTimer, stopFrameLoop]);

	const startFrameLoopRef = useRef<() => void>(() => {});

	const scheduleFrameWake = useCallback(
		(delayMs: number) => {
			clearWakeTimer();

			wakeTimerRef.current = setTimeout(
				() => {
					wakeTimerRef.current = null;
					startFrameLoopRef.current();
				},
				Math.max(1, Math.ceil(delayMs)),
			);
		},
		[clearWakeTimer],
	);

	const syncImmediate = useCallback(
		(nextContent: string) => {
			stopScheduling();

			// Skip the codepoint split until smoothing is actually active.
			const chars = initializedRef.current ? [...nextContent] : null;
			const now = getNow();

			targetContentRef.current = nextContent;
			if (chars) {
				targetCharsRef.current = chars;
				targetCountRef.current = chars.length;
				displayedCountRef.current = chars.length;
				lastInputCountRef.current = chars.length;
			}

			displayedContentRef.current = nextContent;
			setDisplayedContent(nextContent);

			emaCpsRef.current = config.defaultCps;
			chunkSizeEmaRef.current = 1;
			arrivalCpsEmaRef.current = config.defaultCps;
			lastInputTsRef.current = now;
		},
		[config.defaultCps, stopScheduling],
	);

	const startFrameLoop = useCallback(() => {
		clearWakeTimer();
		if (rafRef.current !== null) return;

		const tick = (ts: number) => {
			if (lastFrameTsRef.current === null) {
				lastFrameTsRef.current = ts;
				rafRef.current = requestAnimationFrame(tick);
				return;
			}

			const frameIntervalMs = Math.max(0, ts - lastFrameTsRef.current);
			const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.05));
			lastFrameTsRef.current = ts;

			const targetCount = targetCountRef.current;
			const displayedCount = displayedCountRef.current;
			const backlog = targetCount - displayedCount;

			if (backlog <= 0) {
				stopFrameLoop();
				return;
			}

			const now = getNow();
			const idleMs = now - lastInputTsRef.current;
			const inputActive = idleMs <= config.activeInputWindowMs;
			const settling = !inputActive && idleMs >= config.settleAfterMs;

			const baseCps = clamp(emaCpsRef.current, config.minCps, config.maxCps);
			const baseLagChars = Math.max(
				1,
				Math.round((baseCps * config.targetBufferMs) / 1000),
			);
			const lagUpperBound = Math.max(baseLagChars + 2, baseLagChars * 3);
			const targetLagChars = inputActive
				? Math.round(
						clamp(
							baseLagChars + chunkSizeEmaRef.current * 0.35,
							baseLagChars,
							lagUpperBound,
						),
					)
				: 0;
			const desiredDisplayed = Math.max(0, targetCount - targetLagChars);

			let currentCps: number;
			if (inputActive) {
				const backlogPressure =
					targetLagChars > 0 ? backlog / targetLagChars : 1;
				const chunkPressure =
					targetLagChars > 0 ? chunkSizeEmaRef.current / targetLagChars : 1;
				const arrivalPressure = arrivalCpsEmaRef.current / Math.max(baseCps, 1);
				const combinedPressure = clamp(
					backlogPressure * 0.6 + chunkPressure * 0.25 + arrivalPressure * 0.15,
					1,
					4.5,
				);
				const activeCap = clamp(
					config.maxActiveCps + chunkSizeEmaRef.current * 6,
					config.maxActiveCps,
					config.maxFlushCps,
				);
				currentCps = clamp(
					baseCps * combinedPressure,
					config.minCps,
					activeCap,
				);
			} else if (settling) {
				// If upstream likely ended, cap the remaining tail duration so we
				// don't keep replaying old backlog for seconds.
				const drainTargetMs = clamp(
					backlog * 8,
					config.settleDrainMinMs,
					config.settleDrainMaxMs,
				);
				const settleCps = (backlog * 1000) / drainTargetMs;
				currentCps = clamp(settleCps, config.flushCps, config.maxFlushCps);
			} else {
				const idleFlushCps = Math.max(
					config.flushCps,
					baseCps * 1.8,
					arrivalCpsEmaRef.current * 0.8,
				);
				currentCps = clamp(idleFlushCps, config.flushCps, config.maxFlushCps);
			}

			const urgentBacklog =
				inputActive && targetLagChars > 0 && backlog > targetLagChars * 2.2;
			const burstyInput =
				inputActive && chunkSizeEmaRef.current >= targetLagChars * 0.9;
			const minRevealChars = inputActive
				? urgentBacklog || burstyInput
					? 2
					: 1
				: 2;
			let revealChars = Math.max(
				minRevealChars,
				Math.round(currentCps * dtSeconds),
			);

			if (inputActive) {
				const shortfall = desiredDisplayed - displayedCount;
				if (shortfall <= 0) {
					stopFrameLoop();
					scheduleFrameWake(config.activeInputWindowMs - idleMs);
					return;
				}
				revealChars = Math.min(revealChars, shortfall, backlog);
			} else {
				revealChars = Math.min(revealChars, backlog);
			}

			let nextCount = displayedCount + revealChars;
			const targetChars = targetCharsRef.current;
			let lookahead = 0;
			while (
				nextCount < targetCount &&
				lookahead < MAX_MARKER_LOOKAHEAD &&
				isMarkdownMarkerChar(targetChars[nextCount - 1] ?? "")
			) {
				nextCount += 1;
				lookahead += 1;
			}
			const segment = targetChars.slice(displayedCount, nextCount).join("");

			if (segment) {
				const nextDisplayed = displayedContentRef.current + segment;
				displayedContentRef.current = nextDisplayed;
				displayedCountRef.current = nextCount;
				setDisplayedContent(nextDisplayed);
			} else {
				displayedContentRef.current = targetContentRef.current;
				displayedCountRef.current = targetCount;
				setDisplayedContent(targetContentRef.current);
			}

			rafRef.current = requestAnimationFrame(tick);
		};

		rafRef.current = requestAnimationFrame(tick);
	}, [
		clearWakeTimer,
		config.activeInputWindowMs,
		config.flushCps,
		config.maxActiveCps,
		config.maxCps,
		config.maxFlushCps,
		config.minCps,
		config.settleAfterMs,
		config.settleDrainMaxMs,
		config.settleDrainMinMs,
		config.targetBufferMs,
		scheduleFrameWake,
		stopFrameLoop,
	]);
	startFrameLoopRef.current = startFrameLoop;

	useEffect(() => {
		if (!enabled) {
			// Bypass: just shadow `content` as the displayed value. No splits.
			// Drop the lazy-init flag too so a future `enabled=true` flip
			// re-seeds the char arrays from the current content (otherwise
			// the append-only path would diff against a stale codepoint
			// snapshot from the last enabled run).
			stopScheduling();
			initializedRef.current = false;
			targetCharsRef.current = [];
			targetCountRef.current = 0;
			displayedCountRef.current = 0;
			lastInputCountRef.current = 0;
			if (
				targetContentRef.current !== content ||
				displayedContentRef.current !== content
			) {
				targetContentRef.current = content;
				displayedContentRef.current = content;
				setDisplayedContent(content);
			}
			return;
		}

		ensureInitialized(targetContentRef.current);

		const prevTargetContent = targetContentRef.current;
		if (content === prevTargetContent) return;

		const now = getNow();
		const appendOnly = content.startsWith(prevTargetContent);

		if (!appendOnly) {
			// Non-monotonic update (rewrite, truncation, restart): jump to the
			// new content without animating diff.
			syncImmediate(content);
			return;
		}

		const appended = content.slice(prevTargetContent.length);
		const appendedChars = [...appended];
		const appendedCount = appendedChars.length;

		if (appendedCount > config.largeAppendChars) {
			// Single delta too big to smooth (paste / large flush) — skip
			// animation to avoid seconds of unnecessary backlog.
			syncImmediate(content);
			return;
		}

		targetContentRef.current = content;
		targetCharsRef.current = [...targetCharsRef.current, ...appendedChars];
		targetCountRef.current += appendedCount;

		const deltaChars = targetCountRef.current - lastInputCountRef.current;
		const deltaMs = Math.max(1, now - lastInputTsRef.current);

		if (deltaChars > 0) {
			const instantCps = (deltaChars * 1000) / deltaMs;
			const normalizedInstantCps = clamp(
				instantCps,
				config.minCps,
				config.maxFlushCps * 2,
			);
			const chunkEmaAlpha = 0.35;
			chunkSizeEmaRef.current =
				chunkSizeEmaRef.current * (1 - chunkEmaAlpha) +
				appendedCount * chunkEmaAlpha;
			arrivalCpsEmaRef.current =
				arrivalCpsEmaRef.current * (1 - chunkEmaAlpha) +
				normalizedInstantCps * chunkEmaAlpha;

			const clampedCps = clamp(instantCps, config.minCps, config.maxActiveCps);
			emaCpsRef.current =
				emaCpsRef.current * (1 - config.emaAlpha) +
				clampedCps * config.emaAlpha;
		}

		lastInputTsRef.current = now;
		lastInputCountRef.current = targetCountRef.current;

		startFrameLoop();
	}, [
		config.emaAlpha,
		config.largeAppendChars,
		config.maxActiveCps,
		config.maxCps,
		config.maxFlushCps,
		config.minCps,
		content,
		enabled,
		ensureInitialized,
		startFrameLoop,
		stopScheduling,
		syncImmediate,
	]);

	useEffect(() => {
		return () => {
			stopScheduling();
		};
	}, [stopScheduling]);

	return displayedContent;
};
