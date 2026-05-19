import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	listRemoteRuntimes,
	type RuntimeEntry,
	reconnectRemoteRuntime,
	subscribeUiMutations,
} from "@/lib/api";

/// Reconnect banner for disconnected remote runtimes (phase 25a).
///
/// The backend's auto-reconnect loop already retries
/// `connect_from_config` with exponential backoff for any
/// `RuntimeState::Disconnected` entry. This banner is the
/// user-facing signal: as soon as a registered remote falls out
/// of Connected, a strip appears at the top of the shell with the
/// runtime's name, the latest failure reason, and a "Reconnect now"
/// button that calls the same RPC the dev panel uses.
///
/// The banner self-dismisses when every runtime is Connected
/// again. Multiple offline runtimes stack into a single banner
/// row each.
export function RemoteConnectionBanner() {
	const queryClient = useQueryClient();
	const runtimesQuery = useQuery({
		queryKey: ["remote-runtimes"],
		queryFn: listRemoteRuntimes,
		// Refresh aggressively while there's something disconnected.
		// The auto-reconnect loop's `remoteReconnectAttempt` events
		// also invalidate this key, but a fallback poll guards against
		// a dropped event channel.
		refetchInterval: 10_000,
		staleTime: 5_000,
	});

	// Track per-runtime "we're trying right now" sub-state. The
	// backend publishes `remoteReconnectAttempt` with `succeeded: null`
	// while an attempt is in flight; when it resolves the next event
	// flips `succeeded` to `true` / `false`. The banner uses this to
	// flip the icon from a static alert into a spinning loader so the
	// user has live feedback during a retry.
	const [inFlightByName, setInFlightByName] = useState<
		Record<string, { attempt: number } | undefined>
	>({});
	const [lastAttempt, setLastAttempt] = useState<
		Record<string, { attempt: number; succeeded: boolean } | undefined>
	>({});

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		void subscribeUiMutations((event) => {
			if (disposed) return;
			if (event.type !== "remoteReconnectAttempt") return;
			if (event.succeeded === null) {
				setInFlightByName((prev) => ({
					...prev,
					[event.name]: { attempt: event.attempt },
				}));
			} else {
				setInFlightByName((prev) => {
					if (!prev[event.name]) return prev;
					const next = { ...prev };
					delete next[event.name];
					return next;
				});
				setLastAttempt((prev) => ({
					...prev,
					[event.name]: {
						attempt: event.attempt,
						succeeded: event.succeeded as boolean,
					},
				}));
			}
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

	const reconnectMutation = useMutation({
		mutationFn: (name: string) => reconnectRemoteRuntime(name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
		},
	});

	const offlineRuntimes = useMemo(() => {
		const all = runtimesQuery.data ?? [];
		return all.filter(
			(entry) => !entry.isLocal && entry.state.type !== "connected",
		);
	}, [runtimesQuery.data]);

	if (offlineRuntimes.length === 0) return null;

	return (
		<div
			data-testid="remote-connection-banner"
			role="status"
			aria-live="polite"
			className="flex flex-col gap-1 border-b border-amber-700/30 bg-amber-500/10 px-4 py-2 text-[12px]"
		>
			{offlineRuntimes.map((entry) => (
				<BannerRow
					key={entry.name}
					entry={entry}
					inFlight={inFlightByName[entry.name]}
					lastAttempt={lastAttempt[entry.name]}
					reconnecting={
						reconnectMutation.isPending &&
						reconnectMutation.variables === entry.name
					}
					onReconnect={() => reconnectMutation.mutate(entry.name)}
				/>
			))}
		</div>
	);
}

function BannerRow({
	entry,
	inFlight,
	lastAttempt,
	reconnecting,
	onReconnect,
}: {
	entry: RuntimeEntry;
	inFlight: { attempt: number } | undefined;
	lastAttempt: { attempt: number; succeeded: boolean } | undefined;
	reconnecting: boolean;
	onReconnect: () => void;
}) {
	const reason = readReason(entry);
	const stateLabel =
		entry.state.type === "degraded"
			? "Degraded"
			: entry.state.type === "disconnected"
				? "Disconnected"
				: entry.state.type;
	const isRetrying = inFlight !== undefined || reconnecting;
	return (
		<div
			data-testid={`remote-connection-banner-row-${entry.name}`}
			data-runtime-state={entry.state.type}
			className="flex items-center gap-2"
		>
			{isRetrying ? (
				<Loader2
					className="size-3.5 shrink-0 animate-spin text-amber-400"
					aria-hidden
				/>
			) : (
				<CircleAlert className="size-3.5 shrink-0 text-amber-400" aria-hidden />
			)}
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-foreground">
					{stateLabel} · {entry.name}
				</span>
				{reason || lastAttempt ? (
					<span className="truncate text-[11px] text-muted-foreground">
						{reason}
						{lastAttempt && !lastAttempt.succeeded ? (
							<>
								{reason ? " · " : ""}
								auto-retry #{lastAttempt.attempt} failed
							</>
						) : null}
						{inFlight ? (
							<>
								{reason ? " · " : ""}
								auto-retry #{inFlight.attempt} in progress
							</>
						) : null}
					</span>
				) : null}
			</div>
			<Button
				variant="outline"
				size="sm"
				disabled={isRetrying}
				onClick={onReconnect}
				aria-label={`Reconnect ${entry.name} now`}
			>
				<RefreshCw className="mr-1.5 size-3.5" />
				Reconnect now
			</Button>
		</div>
	);
}

function readReason(entry: RuntimeEntry): string | null {
	switch (entry.state.type) {
		case "degraded":
		case "disconnected":
			return entry.state.reason ?? null;
		default:
			return null;
	}
}

// X import kept reserved for a future dismiss/cancel affordance —
// the current iteration only auto-dismisses on full recovery, but
// the dropdown will likely want a "stop trying" button later.
void X;
