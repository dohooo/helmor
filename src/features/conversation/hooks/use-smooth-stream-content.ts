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

const countChars = (text: string): number => [...text].length;

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
	const displayedCountRef = useRef(countChars(content));

	const targetContentRef = useRef(content);
	const targetCharsRef = useRef([...content]);
	const targetCountRef = useRef(targetCharsRef.current.length);

	const emaCpsRef = useRef(config.defaultCps);
	const lastInputTsRef = useRef(0);
	const lastInputCountRef = useRef(targetCountRef.current);
	const chunkSizeEmaRef = useRef(1);
	const arrivalCpsEmaRef = useRef(config.defaultCps);

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

			const chars = [...nextContent];
			const now = getNow();

			targetContentRef.current = nextContent;
			targetCharsRef.current = chars;
			targetCountRef.current = chars.length;

			displayedContentRef.current = nextContent;
			displayedCountRef.current = chars.length;
			setDisplayedContent(nextContent);

			emaCpsRef.current = config.defaultCps;
			chunkSizeEmaRef.current = 1;
			arrivalCpsEmaRef.current = config.defaultCps;
			lastInputTsRef.current = now;
			lastInputCountRef.current = chars.length;
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

			const nextCount = displayedCount + revealChars;
			const segment = targetCharsRef.current
				.slice(displayedCount, nextCount)
				.join("");

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
			syncImmediate(content);
			return;
		}

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
		startFrameLoop,
		syncImmediate,
	]);

	useEffect(() => {
		return () => {
			stopScheduling();
		};
	}, [stopScheduling]);

	return displayedContent;
};
