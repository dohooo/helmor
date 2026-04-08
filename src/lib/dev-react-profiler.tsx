/**
 * React Profiler aggregator for Helmor.
 *
 * Wraps the per-render data that React's <Profiler> emits into a long-lived
 * in-memory summary keyed by Profiler `id`. The summary is the source of
 * truth for the Phase 1 bottleneck report and for ad-hoc inspection during
 * developer sessions.
 *
 * Gating: enabled iff `?profile=1` is in the URL. Uses its own flag (rather
 * than `perfHud` or `perfMarks`) so the three perf overlays can be turned on
 * independently — Profiler instrumentation has the highest steady-state
 * cost of the three, so we don't want it riding piggyback on the lighter
 * tools.
 *
 * Usage:
 *
 *   import { HelmorProfiler } from "@/lib/dev-react-profiler";
 *
 *   <HelmorProfiler id="WorkspacePanel">
 *     <WorkspacePanel ... />
 *   </HelmorProfiler>
 *
 * When the flag is off, <HelmorProfiler> is a passthrough: it returns
 * `children` directly with zero React.Profiler overhead.
 *
 * Programmatic readback:
 *
 *   window.__HELMOR_PROFILER__.summary()  // sorted by total mount+update ms
 *   window.__HELMOR_PROFILER__.clear()    // reset between scenarios
 */

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

export type ProfilerAggregate = {
	id: string;
	mountCount: number;
	updateCount: number;
	totalActualMs: number;
	totalBaseMs: number;
	maxActualMs: number;
	maxBaseMs: number;
	lastPhase: "mount" | "update" | "nested-update";
};

const aggregates = new Map<string, ProfilerAggregate>();
let cachedEnabled: boolean | null = null;

function isEnabled(): boolean {
	if (cachedEnabled !== null) return cachedEnabled;
	if (typeof window === "undefined") {
		cachedEnabled = false;
		return false;
	}
	if (!import.meta.env.DEV) {
		cachedEnabled = false;
		return false;
	}
	try {
		cachedEnabled =
			new URLSearchParams(window.location.search).get("profile") === "1";
	} catch {
		cachedEnabled = false;
	}
	return cachedEnabled;
}

const onRender: ProfilerOnRenderCallback = (
	id,
	phase,
	actualDuration,
	baseDuration,
) => {
	let entry = aggregates.get(id);
	if (!entry) {
		entry = {
			id,
			mountCount: 0,
			updateCount: 0,
			totalActualMs: 0,
			totalBaseMs: 0,
			maxActualMs: 0,
			maxBaseMs: 0,
			lastPhase: "mount",
		};
		aggregates.set(id, entry);
	}
	if (phase === "mount") {
		entry.mountCount += 1;
	} else {
		entry.updateCount += 1;
	}
	entry.totalActualMs += actualDuration;
	entry.totalBaseMs += baseDuration;
	if (actualDuration > entry.maxActualMs) entry.maxActualMs = actualDuration;
	if (baseDuration > entry.maxBaseMs) entry.maxBaseMs = baseDuration;
	entry.lastPhase = phase;
};

declare global {
	interface Window {
		__HELMOR_PROFILER__?: {
			enabled: () => boolean;
			summary: () => ProfilerAggregate[];
			clear: () => void;
		};
	}
}

export function getProfilerSummary(): ProfilerAggregate[] {
	return Array.from(aggregates.values()).sort(
		(a, b) => b.totalActualMs - a.totalActualMs,
	);
}

export function clearProfilerSummary(): void {
	aggregates.clear();
}

if (typeof window !== "undefined" && isEnabled()) {
	window.__HELMOR_PROFILER__ = {
		enabled: () => true,
		summary: getProfilerSummary,
		clear: clearProfilerSummary,
	};
}

/**
 * Conditional <Profiler> wrapper. When `?profile=1` is off this returns
 * `children` directly with zero overhead.
 */
export function HelmorProfiler({
	id,
	children,
}: {
	id: string;
	children: ReactNode;
}) {
	if (!isEnabled()) return children;
	return (
		<Profiler id={id} onRender={onRender}>
			{children}
		</Profiler>
	);
}
