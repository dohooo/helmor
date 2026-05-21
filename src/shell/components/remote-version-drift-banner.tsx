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
 * - The actual reinstall lives outside this banner today: the
 *   operator follows the docs' "Pre-installing the daemon manually"
 *   section to swap the binary, then clicks Reconnect.
 */

import { ArrowUpCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { subscribeUiMutations } from "@/lib/api";

type DriftAlert = {
	name: string;
	daemonVersion: string;
	desktopVersion: string;
	detectedAtMs: number;
};

export function RemoteVersionDriftBanner() {
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
	onDismiss,
}: {
	alert: DriftAlert;
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
				size="icon"
				variant="ghost"
				className="size-7 text-amber-100 hover:bg-amber-900/40 hover:text-amber-50"
				onClick={onDismiss}
				aria-label={`Dismiss version drift alert for ${alert.name}`}
				data-testid={`remote-version-drift-dismiss-${alert.name}`}
			>
				<X className="size-3.5" />
			</Button>
		</div>
	);
}
