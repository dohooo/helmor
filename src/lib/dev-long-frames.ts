/**
 * Long-frame / FPS telemetry for Helmor.
 *
 * Two collection paths:
 *
 *   1. PerformanceObserver({ type: "long-animation-frame" }) — preferred when
 *      available. Reports rich entries including renderStart, styleAndLayoutStart,
 *      blockingDuration, and the script attributions inside the frame. Currently
 *      Chromium-only; WebKit (the Tauri release-mode runtime on macOS) does NOT
 *      support it as of writing.
 *
 *   2. requestAnimationFrame self-timing fallback — measures the wall-clock gap
 *      between consecutive rAF callbacks. Anything noticeably above the
 *      monitor's frame budget is recorded as a long frame. This is the path
 *      that actually fires inside Tauri WKWebView and is therefore the source
 *      of truth for the "Helmor 60→40 fps drop" the user is hunting.
 *
 * Both paths feed the same in-memory ring buffer and the same on-screen HUD.
 *
 * Gating: enabled iff `?perfHud=1` is in the URL OR
 * `VITE_HELMOR_PERF_HUD=1` is set at build time. The flag is shared with
 * `dev-react-scan.ts` so a single param flips the entire perf overlay.
 *
 * The collector runs in BOTH dev mode and release mode — unlike most of our
 * other dev tooling, this one explicitly stays alive in production builds so
 * we can profile the real Tauri release runtime that the user actually sees
 * the framerate drop in. There is zero work done unless the flag is on.
 */

const LONG_FRAME_BUFFER_LIMIT = 200;
const SLOW_FRAME_THRESHOLD_MS = 50; // > 50ms => recorded as a "long frame" (matches LoAF spec)
const HUD_UPDATE_INTERVAL_MS = 250;

export type LongFrameEntry = {
	source: "loaf" | "raf";
	startTime: number;
	durationMs: number;
	// Only populated by the LoAF path.
	blockingDurationMs?: number;
	scripts?: Array<{
		name: string;
		entryType: string;
		invokerType?: string;
		invoker?: string;
		duration: number;
		forcedStyleAndLayoutDuration?: number;
	}>;
};

type FpsState = {
	frameCount: number;
	windowStartMs: number;
	currentFps: number;
	worstFrameInWindowMs: number;
	worstFrameRollingMs: number; // worst over last 5s
	worstFrameRollingResetAtMs: number;
};

const longFrameBuffer: LongFrameEntry[] = [];
const fpsState: FpsState = {
	frameCount: 0,
	windowStartMs: 0,
	currentFps: 0,
	worstFrameInWindowMs: 0,
	worstFrameRollingMs: 0,
	worstFrameRollingResetAtMs: 0,
};

let initialized = false;
let observerCleanup: (() => void) | null = null;
let rafCleanup: (() => void) | null = null;
let hudCleanup: (() => void) | null = null;

declare global {
	interface Window {
		__HELMOR_LONG_FRAMES__?: {
			enabled: () => boolean;
			get: () => LongFrameEntry[];
			clear: () => void;
			dumpJson: () => string;
			downloadJson: () => void;
			fps: () => number;
			worstFrameMs: () => number;
		};
	}
}

function isEnabled(): boolean {
	if (typeof window === "undefined") return false;
	const envFlag = import.meta.env.VITE_HELMOR_PERF_HUD === "1";
	let queryFlag = false;
	try {
		queryFlag =
			new URLSearchParams(window.location.search).get("perfHud") === "1";
	} catch {
		// noop
	}
	return envFlag || queryFlag;
}

function pushFrame(entry: LongFrameEntry) {
	longFrameBuffer.push(entry);
	if (longFrameBuffer.length > LONG_FRAME_BUFFER_LIMIT) {
		longFrameBuffer.shift();
	}
	if (entry.durationMs > fpsState.worstFrameRollingMs) {
		fpsState.worstFrameRollingMs = entry.durationMs;
	}
	if (entry.durationMs > fpsState.worstFrameInWindowMs) {
		fpsState.worstFrameInWindowMs = entry.durationMs;
	}
}

// ---------------------------------------------------------------------------
// Collector 1: Long Animation Frames API (Chromium / Edge)
// ---------------------------------------------------------------------------

type LoafScriptAttribution = {
	name: string;
	entryType: string;
	invokerType?: string;
	invoker?: string;
	duration: number;
	forcedStyleAndLayoutDuration?: number;
};

type LoafEntry = PerformanceEntry & {
	blockingDuration?: number;
	scripts?: LoafScriptAttribution[];
};

function tryStartLoafObserver(): (() => void) | null {
	if (typeof PerformanceObserver === "undefined") {
		return null;
	}
	const supportedTypes = (
		PerformanceObserver as unknown as {
			supportedEntryTypes?: string[];
		}
	).supportedEntryTypes;
	if (!supportedTypes?.includes("long-animation-frame")) {
		return null;
	}
	let observer: PerformanceObserver;
	try {
		observer = new PerformanceObserver((list) => {
			for (const raw of list.getEntries() as LoafEntry[]) {
				pushFrame({
					source: "loaf",
					startTime: raw.startTime,
					durationMs: raw.duration,
					blockingDurationMs: raw.blockingDuration,
					scripts: raw.scripts?.map((s) => ({
						name: s.name,
						entryType: s.entryType,
						invokerType: s.invokerType,
						invoker: s.invoker,
						duration: s.duration,
						forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
					})),
				});
			}
		});
		observer.observe({
			type: "long-animation-frame",
			buffered: true,
		} as PerformanceObserverInit);
	} catch {
		return null;
	}
	return () => {
		try {
			observer.disconnect();
		} catch {
			// noop
		}
	};
}

// ---------------------------------------------------------------------------
// Collector 2: requestAnimationFrame self-timing fallback (WebKit / Tauri)
// ---------------------------------------------------------------------------

function startRafFallback(): () => void {
	let lastFrameTime = performance.now();
	let rafId = 0;
	let cancelled = false;

	const tick = (now: number) => {
		if (cancelled) return;

		const delta = now - lastFrameTime;
		lastFrameTime = now;

		// FPS counter (rolling per-second)
		fpsState.frameCount += 1;
		if (fpsState.windowStartMs === 0) {
			fpsState.windowStartMs = now;
		}
		const windowAge = now - fpsState.windowStartMs;
		if (windowAge >= 1000) {
			fpsState.currentFps = (fpsState.frameCount * 1000) / windowAge;
			fpsState.frameCount = 0;
			fpsState.windowStartMs = now;
			fpsState.worstFrameInWindowMs = 0;
		}

		// Decay the 5s rolling worst frame
		if (now - fpsState.worstFrameRollingResetAtMs > 5000) {
			fpsState.worstFrameRollingMs = 0;
			fpsState.worstFrameRollingResetAtMs = now;
		}

		// Long frame? Record it.
		// Note: we use SLOW_FRAME_THRESHOLD_MS (50ms) instead of the budget
		// (16.67ms) because the rAF gap will routinely be >16.67ms even on a
		// healthy 60fps display when other tabs steal time slices, and we do
		// NOT want to flood the buffer with noise. 50ms is the same threshold
		// that Long Animation Frames API uses by spec, so the two paths report
		// comparable events.
		if (delta >= SLOW_FRAME_THRESHOLD_MS) {
			pushFrame({
				source: "raf",
				startTime: now - delta,
				durationMs: delta,
			});
		}

		rafId = requestAnimationFrame(tick);
	};

	rafId = requestAnimationFrame(tick);

	return () => {
		cancelled = true;
		if (rafId) cancelAnimationFrame(rafId);
	};
}

// ---------------------------------------------------------------------------
// HUD overlay
// ---------------------------------------------------------------------------

function mountHud(): () => void {
	if (typeof document === "undefined") return () => undefined;

	const hud = document.createElement("div");
	hud.id = "__helmor-perf-hud__";
	hud.setAttribute(
		"style",
		[
			"position: fixed",
			"left: 12px",
			"bottom: 12px",
			"z-index: 2147483647",
			"padding: 6px 8px",
			"background: rgba(0, 0, 0, 0.78)",
			"color: rgba(255, 255, 255, 0.95)",
			"font: 11px / 1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
			"border-radius: 6px",
			"pointer-events: none",
			"user-select: none",
			"min-width: 130px",
			"text-align: left",
			"box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4)",
			// Render via the compositor — never trigger layout from this overlay.
			"will-change: contents",
			"contain: layout style paint",
		].join("; "),
	);
	hud.textContent = "FPS …";

	const append = () => {
		if (document.body) {
			document.body.appendChild(hud);
		} else {
			document.addEventListener("DOMContentLoaded", append, { once: true });
		}
	};
	append();

	const update = () => {
		const fps = Math.round(fpsState.currentFps);
		const worst5s = Math.round(fpsState.worstFrameRollingMs);
		const totalLong = longFrameBuffer.length;
		const fpsColor = fps >= 58 ? "#84e1bc" : fps >= 45 ? "#fbbf24" : "#f87171";
		hud.innerHTML =
			`<span style="color:${fpsColor}; font-weight: 600">FPS ${fps}</span>` +
			`<br>worst 5s: ${worst5s}ms` +
			`<br>long frames: ${totalLong}`;
	};
	const intervalId = window.setInterval(update, HUD_UPDATE_INTERVAL_MS);

	return () => {
		clearInterval(intervalId);
		hud.remove();
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initDevLongFrames(): void {
	if (initialized) return;
	if (!isEnabled()) return;
	if (typeof window === "undefined") return;

	initialized = true;

	observerCleanup = tryStartLoafObserver();
	// Always run the rAF fallback in addition to LoAF — LoAF only fires for
	// frames longer than the spec threshold (50ms) AND only on Chromium, so
	// the rAF path gives us per-frame FPS even on Chrome AND fills in WebKit.
	rafCleanup = startRafFallback();
	hudCleanup = mountHud();

	window.__HELMOR_LONG_FRAMES__ = {
		enabled: () => true,
		get: () => longFrameBuffer.slice(),
		clear: () => {
			longFrameBuffer.length = 0;
			fpsState.worstFrameRollingMs = 0;
			fpsState.worstFrameInWindowMs = 0;
		},
		dumpJson: () =>
			JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					fps: Math.round(fpsState.currentFps),
					worstFrameRollingMs: Math.round(fpsState.worstFrameRollingMs),
					longFrames: longFrameBuffer,
				},
				null,
				2,
			),
		downloadJson: () => {
			if (typeof window === "undefined") return;
			const blob = new Blob([window.__HELMOR_LONG_FRAMES__!.dumpJson()], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `helmor-long-frames-${Date.now()}.json`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		},
		fps: () => fpsState.currentFps,
		worstFrameMs: () => fpsState.worstFrameRollingMs,
	};
}

export function teardownDevLongFrames(): void {
	if (!initialized) return;
	initialized = false;
	observerCleanup?.();
	observerCleanup = null;
	rafCleanup?.();
	rafCleanup = null;
	hudCleanup?.();
	hudCleanup = null;
	delete window.__HELMOR_LONG_FRAMES__;
}
