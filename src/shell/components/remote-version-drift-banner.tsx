/**
 * Track E5 (auto-update awareness): banner surfacing remote daemons
 * whose helmor-server binary version is older than the running
 * desktop.
 *
 * The auto-install path on the desktop only triggers reinstall when
 * the *protocol* version disagrees — a daemon that's protocol-
 * compatible but missing a recent bug fix (or a security update)
 * would otherwise slip through silently. The backend's
 * `connect_remote_runtime` + `reconnect_remote_runtime` paths
 * compare the daemon's `runtime.health.version` against the
 * desktop's `CARGO_PKG_VERSION` after every successful handshake
 * and emit `remoteServerVersionDrift` when the daemon is older.
 *
 * UX intent:
 * - Amber tone (informational; less urgent than crash-loop).
 * - Per-runtime dismiss (local-only — re-fires on the next
 *   connect / reconnect that exercises the drift detector).
 * - "Reinstall" action drives `reinstall_remote_daemon` which
 *   force-installs the binary + reconnects. The button shows a
 *   spinner during the reinstall (multi-second operation: scp /
 *   download + verify + reconnect).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { reinstallRemoteDaemon, subscribeUiMutations } from "@/lib/api";

type DriftAlert = {
	name: string;
	daemonVersion: string;
	desktopVersion: string;
	detectedAtMs: number;
};

export function RemoteVersionDriftBanner() {
	const queryClient = useQueryClient();
	// Keyed by runtime name so re-fires (manual reconnect after
	// upgrading the desktop, etc.) replace the stale row rather
	// than stacking.
	const [alerts, setAlerts] = useState<Record<string, DriftAlert>>({});

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		void subscribeUiMutations((event) => {
			if (disposed) return;
			if (event.type !== "remoteServerVersionDrift") return;
			setAlerts((prev) => ({
				...prev,
				[event.name]: {
					name: event.name,
					daemonVersion: event.daemonVersion,
					desktopVersion: event.desktopVersion,
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

	const reinstall = useMutation({
		mutationFn: (name: string) => reinstallRemoteDaemon(name),
		onSuccess: (health, name) => {
			toast.success(
				`Reinstalled helmor-server on ${name} — now running ${health.version}`,
			);
			// Drop the alert from local state. If the daemon's STILL
			// older somehow, the connect path re-emits the event +
			// the banner pops again.
			setAlerts((prev) => {
				const next = { ...prev };
				delete next[name];
				return next;
			});
			void queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
		},
		onError: (err, name) => {
			toast.error(
				`Reinstall on ${name} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		},
	});

	const entries = Object.values(alerts);
	if (entries.length === 0) return null;

	return (
		<div
			className="flex flex-col gap-1 border-b border-amber-900/40 bg-amber-950/30"
			data-testid="remote-version-drift-banner"
		>
			{entries.map((alert) => (
				<DriftRow
					key={alert.name}
					alert={alert}
					reinstallPending={
						reinstall.isPending && reinstall.variables === alert.name
					}
					onReinstall={() => reinstall.mutate(alert.name)}
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
	);
}

function DriftRow({
	alert,
	reinstallPending,
	onReinstall,
	onDismiss,
}: {
	alert: DriftAlert;
	reinstallPending: boolean;
	onReinstall: () => void;
	onDismiss: () => void;
}) {
	return (
		<div
			className="flex items-center gap-3 px-3 py-2 text-[12px] text-amber-100"
			data-testid={`remote-version-drift-row-${alert.name}`}
		>
			<ArrowUpCircle className="size-3.5 shrink-0 text-amber-300" />
			<span className="min-w-0 flex-1">
				<strong className="font-medium">{alert.name}</strong>'s daemon is on{" "}
				<code className="rounded bg-amber-900/30 px-1 font-mono">
					{alert.daemonVersion}
				</code>
				; this desktop runs{" "}
				<code className="rounded bg-amber-900/30 px-1 font-mono">
					{alert.desktopVersion}
				</code>
				. Reinstall recommended — recent fixes may be missing on the remote.
			</span>
			<Button
				size="sm"
				variant="ghost"
				className="text-amber-100 hover:bg-amber-900/40 hover:text-amber-50"
				disabled={reinstallPending}
				onClick={onReinstall}
				data-testid={`remote-version-drift-reinstall-${alert.name}`}
			>
				{reinstallPending ? (
					<>
						<Loader2 className="mr-1.5 size-3 animate-spin" />
						Reinstalling…
					</>
				) : (
					<>
						<RefreshCw className="mr-1.5 size-3" />
						Reinstall
					</>
				)}
			</Button>
			<Button
				size="icon"
				variant="ghost"
				className="size-7 text-amber-100 hover:bg-amber-900/40 hover:text-amber-50"
				disabled={reinstallPending}
				onClick={onDismiss}
				aria-label={`Dismiss version drift alert for ${alert.name}`}
				data-testid={`remote-version-drift-dismiss-${alert.name}`}
			>
				<X className="size-3.5" />
			</Button>
		</div>
	);
}
