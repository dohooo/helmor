/**
 * Track E3: shape the "Copy diagnostics" JSON blob a user can paste
 * into a support thread. Pulled out of the Runtime Debug panel
 * (`src/features/settings/panels/runtime-debug.tsx`) so the
 * production Remote Servers panel can offer the same export
 * without bundling the rest of the debug surface.
 *
 * The blob bundles:
 *   - `capturedAtMs` + `desktop` envelope (platform, userAgent).
 *   - `runtime.diagnostics` — state, health, RPC pipe telemetry
 *     (including the protocol version that reviewers ask about
 *     first when triaging mismatch issues), ping.
 *   - `runtime.metrics` — per-method RPC counters + p50/p99 +
 *     recent daemon restart timestamps.
 *   - `daemonLog` — last N lines from the remote daemon's log.
 *
 * Each section degrades cleanly: a failed fetch lands as
 * `{error: <message>}` rather than blanking out the whole export.
 * The desktop calls each fetch via `Promise.allSettled` so one
 * un-responsive probe never blocks the others.
 */

import type {
	DaemonTailLogResult,
	RuntimeDiagnostics,
	RuntimeMetricsResult,
} from "@/lib/api";

export type DiagnosticsErrorStub = { error: string | null };

export type DiagnosticsPayload = {
	capturedAtMs: number;
	runtime: string;
	desktop: {
		platform: string | null;
		userAgent: string | null;
	};
	diagnostics: RuntimeDiagnostics | DiagnosticsErrorStub;
	metrics: {
		uptimeSecs: number;
		recentStartsMs: number[];
		methods: RuntimeMetricsResult["methods"];
	};
	daemonLog: DaemonTailLogResult | DiagnosticsErrorStub;
};

export function buildDiagnosticsPayload(args: {
	runtime: string;
	metrics: RuntimeMetricsResult;
	diagnosticsResult: PromiseSettledResult<RuntimeDiagnostics>;
	logResult: PromiseSettledResult<DaemonTailLogResult>;
	capturedAtMs: number;
	platform: string | null;
	userAgent: string | null;
}): DiagnosticsPayload {
	return {
		capturedAtMs: args.capturedAtMs,
		runtime: args.runtime,
		desktop: {
			platform: args.platform,
			userAgent: args.userAgent,
		},
		diagnostics:
			args.diagnosticsResult.status === "fulfilled"
				? args.diagnosticsResult.value
				: { error: formatErrorMessage(args.diagnosticsResult.reason) },
		metrics: {
			uptimeSecs: args.metrics.uptimeSecs,
			recentStartsMs: args.metrics.recentStartsMs,
			methods: args.metrics.methods,
		},
		daemonLog:
			args.logResult.status === "fulfilled"
				? args.logResult.value
				: { error: formatErrorMessage(args.logResult.reason) },
	};
}

export function formatErrorMessage(err: unknown): string | null {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return null;
}
