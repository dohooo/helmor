/**
 * Track E4 consumer (UI side): banner that surfaces a daemon
 * crash-loop signal to the operator without requiring them to dig
 * into the dev panel.
 *
 * The auto-reconnect loop publishes a `remoteCrashLoopDetected`
 * UiMutationEvent when a daemon's `recent_starts_ms` exceeds the
 * threshold inside the sliding window. Each detection lives at most
 * once per loop episode (the backend's cooldown clears when the
 * window slides past the qualifying restarts), so the banner stack
 * stays focused on real ongoing problems.
 *
 * UX intent:
 * - Distinct visual from the regular reconnect banner — crash-loops
 *   indicate the *daemon itself* is unhealthy, not just the SSH link.
 * - One banner per affected runtime; multi-loop scenarios stack.
 * - "View log" opens a dialog with the daemon's recent log tail
 *   (`daemon.tailLog` RPC) so the operator can diagnose without
 *   opening a parallel SSH session.
 * - "Dismiss" is local-only: clears the banner from this session.
 *   A re-trigger (new episode after window slides) re-shows it.
 *
 * Mounted alongside `<RemoteConnectionBanner>` at the shell layer.
 */

import { AlertOctagon, FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { subscribeUiMutations, tailRemoteDaemonLog } from "@/lib/api";

type CrashLoopAlert = {
	name: string;
	restartCount: number;
	windowMs: number;
	recentStartsMs: number[];
	detectedAtMs: number;
};

export function RemoteCrashLoopBanner() {
	// `alerts` is keyed by runtime name so a re-fire (after the
	// backend cooldown clears + a new episode starts) replaces the
	// stale entry instead of stacking.
	const [alerts, setAlerts] = useState<Record<string, CrashLoopAlert>>({});
	const [logRuntimeName, setLogRuntimeName] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		void subscribeUiMutations((event) => {
			if (disposed) return;
			if (event.type !== "remoteCrashLoopDetected") return;
			setAlerts((prev) => ({
				...prev,
				[event.name]: {
					name: event.name,
					restartCount: event.restartCount,
					windowMs: event.windowMs,
					recentStartsMs: event.recentStartsMs,
					detectedAtMs: Date.now(),
				},
			}));
		}).then((cleanup) => {
			if (disposed) {
				cleanup();
				return;
			}
			unlisten = cleanup;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	const entries = Object.values(alerts);
	if (entries.length === 0) return null;

	return (
		<>
			<div
				className="flex flex-col gap-1 border-b border-rose-900/40 bg-rose-950/30"
				data-testid="remote-crash-loop-banner"
			>
				{entries.map((alert) => (
					<CrashLoopRow
						key={alert.name}
						alert={alert}
						onViewLog={() => setLogRuntimeName(alert.name)}
						onDismiss={() =>
							setAlerts((prev) => {
								const next = { ...prev };
								delete next[alert.name];
								return next;
							})
						}
					/>
				))}
			</div>
			<DaemonLogDialog
				runtimeName={logRuntimeName}
				onOpenChange={(open) => {
					if (!open) setLogRuntimeName(null);
				}}
			/>
		</>
	);
}

function CrashLoopRow({
	alert,
	onViewLog,
	onDismiss,
}: {
	alert: CrashLoopAlert;
	onViewLog: () => void;
	onDismiss: () => void;
}) {
	const windowLabel = formatWindowLabel(alert.windowMs);
	return (
		<div
			className="flex items-center gap-3 px-3 py-2 text-[12px] text-rose-100"
			data-testid={`remote-crash-loop-row-${alert.name}`}
		>
			<AlertOctagon className="size-3.5 shrink-0 text-rose-300" />
			<span className="min-w-0 flex-1">
				<strong className="font-medium">{alert.name}</strong>'s daemon has
				restarted{" "}
				<strong className="font-medium">
					{alert.restartCount} times in the last {windowLabel}
				</strong>
				. Connections may keep dropping until the underlying issue is resolved.
			</span>
			<Button
				size="sm"
				variant="ghost"
				className="text-rose-100 hover:bg-rose-900/40 hover:text-rose-50"
				onClick={onViewLog}
				data-testid={`remote-crash-loop-view-log-${alert.name}`}
			>
				<FileText className="mr-1.5 size-3" />
				View log
			</Button>
			<Button
				size="icon"
				variant="ghost"
				className="size-7 text-rose-100 hover:bg-rose-900/40 hover:text-rose-50"
				onClick={onDismiss}
				aria-label={`Dismiss crash-loop alert for ${alert.name}`}
				data-testid={`remote-crash-loop-dismiss-${alert.name}`}
			>
				<X className="size-3.5" />
			</Button>
		</div>
	);
}

function DaemonLogDialog({
	runtimeName,
	onOpenChange,
}: {
	runtimeName: string | null;
	onOpenChange: (open: boolean) => void;
}) {
	const [lines, setLines] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// Fetch on open; clear on close. Not a query — the dialog is
	// transient + we don't want stale results sticking around in
	// the cache after dismiss.
	useEffect(() => {
		if (!runtimeName) {
			setLines([]);
			setError(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		tailRemoteDaemonLog(runtimeName, 200)
			.then((result) => {
				if (cancelled) return;
				setLines(result.lines);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (cancelled) return;
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [runtimeName]);

	return (
		<Dialog open={runtimeName !== null} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex w-[min(90vw,720px)] max-w-[720px] flex-col gap-3 p-5"
				data-testid="remote-crash-loop-log-dialog"
			>
				<DialogTitle className="text-sm font-semibold">
					Daemon log: {runtimeName}
				</DialogTitle>
				<DialogDescription className="text-[11px] text-muted-foreground">
					Last 200 lines from{" "}
					<code className="font-mono">$HOME/.helmor/server/daemon.log</code> on
					the remote. The most recent entries are at the bottom.
				</DialogDescription>
				{loading ? (
					<div className="py-6 text-center text-[11px] text-muted-foreground">
						Loading…
					</div>
				) : error ? (
					<div
						className="rounded-md border border-rose-700/30 bg-rose-500/5 p-3 text-[11px] text-rose-200"
						data-testid="remote-crash-loop-log-error"
					>
						<strong className="font-medium">Couldn't read the log.</strong>{" "}
						{error}
					</div>
				) : (
					<pre
						className="max-h-[50vh] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[10px] leading-snug text-foreground/90"
						data-testid="remote-crash-loop-log-output"
					>
						{lines.length === 0 ? "(log file is empty)" : lines.join("\n")}
					</pre>
				)}
				<div className="flex justify-end">
					<Button size="sm" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function formatWindowLabel(windowMs: number): string {
	const seconds = Math.round(windowMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return `${minutes}m`;
}
