/**
 * Performance marks helper for diagnostic profiling.
 *
 * Gated behind `?perfMarks=1` URL flag (dev mode only). When disabled, every
 * call compiles to a single boolean check + early return so the production
 * hot path stays free of overhead.
 *
 * Marks/measures show up in:
 *   - Chrome DevTools Performance panel under the "Timings" track
 *   - React DevTools Profiler "Interactions" timeline
 *   - `performance.getEntriesByType("measure")` for programmatic readback
 *
 * All measure names are prefixed with `helmor:` so they are trivial to
 * filter in the DevTools UI.
 *
 * Usage:
 *
 *   import { measureSync } from "@/lib/perf-marks";
 *
 *   const heights = measureSync(
 *     "estimator:thread-heights",
 *     () => estimateThreadRowHeights(...),
 *     { count: messages.length },
 *   );
 */

const MARK_PREFIX = "helmor:";

let cachedEnabled: boolean | null = null;

function computeEnabled(): boolean {
	if (typeof window === "undefined") return false;
	if (!import.meta.env.DEV) return false;
	if (typeof performance === "undefined" || !performance.measure) return false;
	try {
		return new URLSearchParams(window.location.search).get("perfMarks") === "1";
	} catch {
		return false;
	}
}

function enabled(): boolean {
	if (cachedEnabled === null) {
		cachedEnabled = computeEnabled();
	}
	return cachedEnabled;
}

export function isPerfMarksEnabled(): boolean {
	return enabled();
}

/**
 * Single point-in-time mark. Use sparingly; prefer `measureSync` for blocks
 * because the resulting durations are more useful than mark timestamps.
 */
export function mark(name: string): void {
	if (!enabled()) return;
	try {
		performance.mark(`${MARK_PREFIX}${name}`);
	} catch {
		// noop
	}
}

/**
 * Manually record a measure between two named marks. Marks are namespaced to
 * `helmor:` automatically — pass the bare names you used with `mark()`.
 */
export function measure(name: string, start: string, end?: string): void {
	if (!enabled()) return;
	try {
		performance.measure(
			`${MARK_PREFIX}${name}`,
			`${MARK_PREFIX}${start}`,
			end ? `${MARK_PREFIX}${end}` : undefined,
		);
	} catch {
		// Source mark missing — silently ignore so partial instrumentation
		// does not throw in production traces.
	}
}

/**
 * Measure a synchronous block. Returns the function's value. Records a
 * `helmor:<name>` PerformanceMeasure entry with optional `detail` payload
 * (useful for embedding e.g. message counts so the trace UI can group by
 * input size).
 *
 * When perfMarks is disabled, this is a single bool check + a tail call to
 * `fn()` — no Performance API touches at all.
 */
export function measureSync<T>(
	name: string,
	fn: () => T,
	detail?: Record<string, unknown>,
): T {
	if (!enabled()) return fn();
	const startTime = performance.now();
	try {
		return fn();
	} finally {
		const endTime = performance.now();
		try {
			performance.measure(`${MARK_PREFIX}${name}`, {
				start: startTime,
				end: endTime,
				detail,
			});
		} catch {
			// Browser may not support the {start, end, detail} options form
			// (older WebKit). Fall back to a duration-less mark so we still
			// see the entry in DevTools.
			try {
				performance.mark(`${MARK_PREFIX}${name}`);
			} catch {
				// noop
			}
		}
	}
}

/**
 * Reset all `helmor:*` performance entries. Useful between scenarios in a
 * perf test so the second scenario's entries don't get drowned by the first.
 * Safe to call when perfMarks is disabled (becomes a noop).
 */
export function clearPerfMarks(): void {
	if (!enabled()) return;
	try {
		// `clearMeasures` / `clearMarks` accept an optional name filter; we
		// can't filter by prefix, so iterate explicitly.
		const measures = performance.getEntriesByType("measure");
		for (const entry of measures) {
			if (entry.name.startsWith(MARK_PREFIX)) {
				performance.clearMeasures(entry.name);
			}
		}
		const marks = performance.getEntriesByType("mark");
		for (const entry of marks) {
			if (entry.name.startsWith(MARK_PREFIX)) {
				performance.clearMarks(entry.name);
			}
		}
	} catch {
		// noop
	}
}

/**
 * Read all currently-recorded `helmor:*` measures. Returned in start-time
 * order. Used by the perf test harness to assert specific phases ran and
 * to dump a per-stage cost summary.
 */
export type PerfMarkSummary = {
	name: string;
	startTime: number;
	duration: number;
	detail?: unknown;
};

export function getPerfMarkSummaries(): PerfMarkSummary[] {
	if (!enabled()) return [];
	try {
		const measures = performance.getEntriesByType(
			"measure",
		) as PerformanceMeasure[];
		return measures
			.filter((entry) => entry.name.startsWith(MARK_PREFIX))
			.map((entry) => ({
				name: entry.name.slice(MARK_PREFIX.length),
				startTime: entry.startTime,
				duration: entry.duration,
				detail: entry.detail,
			}))
			.sort((a, b) => a.startTime - b.startTime);
	} catch {
		return [];
	}
}

/**
 * Aggregate by name and return total duration + call count for each. Used by
 * the bottleneck report builder. Safe in disabled mode (returns []).
 */
export type PerfMarkAggregate = {
	name: string;
	count: number;
	totalMs: number;
	avgMs: number;
	maxMs: number;
};

export function aggregatePerfMarks(): PerfMarkAggregate[] {
	const summaries = getPerfMarkSummaries();
	const byName = new Map<string, PerfMarkAggregate>();
	for (const entry of summaries) {
		const existing = byName.get(entry.name);
		if (existing) {
			existing.count += 1;
			existing.totalMs += entry.duration;
			existing.maxMs = Math.max(existing.maxMs, entry.duration);
		} else {
			byName.set(entry.name, {
				name: entry.name,
				count: 1,
				totalMs: entry.duration,
				avgMs: 0,
				maxMs: entry.duration,
			});
		}
	}
	for (const aggregate of byName.values()) {
		aggregate.avgMs = aggregate.totalMs / aggregate.count;
	}
	return Array.from(byName.values()).sort((a, b) => b.totalMs - a.totalMs);
}

declare global {
	interface Window {
		__HELMOR_PERF_MARKS__?: {
			enabled: () => boolean;
			get: () => PerfMarkSummary[];
			aggregate: () => PerfMarkAggregate[];
			clear: () => void;
		};
	}
}

if (typeof window !== "undefined" && computeEnabled()) {
	window.__HELMOR_PERF_MARKS__ = {
		enabled: isPerfMarksEnabled,
		get: getPerfMarkSummaries,
		aggregate: aggregatePerfMarks,
		clear: clearPerfMarks,
	};
}
