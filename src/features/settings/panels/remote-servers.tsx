/**
 * Track B (setup UX): production-accessible remote server management.
 *
 * Lists registered remote runtimes with their live state, and exposes
 * an "Add remote server" affordance that opens the guided wizard
 * ({@link AddRemoteServerWizard}). Replaces the dev-gated Runtime
 * Debug panel as the canonical onboarding surface for the 80% case
 * (plain SSH); the dev panel stays put for transport variants,
 * diagnostics deep-dives, and operator-only knobs.
 *
 * Today's surface is intentionally compact:
 *   - Add button → wizard.
 *   - List → name + host + state chip + Disconnect / Reconnect.
 *   - Empty state → "No remote servers yet" + add CTA.
 *
 * Future B-track surfaces (key picker, agent forwarding diagnostics,
 * `~/.ssh/config` editor) layer on top of this panel as additional
 * sections.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Plug2, ServerCog } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AddRemoteServerWizard } from "@/components/add-remote-server-wizard";
import { Button } from "@/components/ui/button";
import {
	disconnectRemoteRuntime,
	listRemoteRuntimes,
	type RuntimeEntry,
	type RuntimeState,
	reconnectRemoteRuntime,
} from "@/lib/api";

export function RemoteServersPanel() {
	const queryClient = useQueryClient();
	const [wizardOpen, setWizardOpen] = useState(false);

	const runtimesQuery = useQuery({
		queryKey: ["remote-runtimes"],
		queryFn: listRemoteRuntimes,
		// Stay subscribed so the auto-reconnect loop's state changes
		// flow into the chip without a manual refresh.
		refetchOnWindowFocus: true,
	});

	const remotes: RuntimeEntry[] = (runtimesQuery.data ?? []).filter(
		(entry) => !entry.isLocal,
	);

	const disconnect = useMutation({
		mutationFn: (name: string) => disconnectRemoteRuntime(name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
		},
		onError: (err) => toast.error(formatError(err)),
	});

	const reconnect = useMutation({
		mutationFn: (name: string) => reconnectRemoteRuntime(name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
		},
		onError: (err) => toast.error(formatError(err)),
	});

	return (
		<section className="flex flex-col gap-4">
			<header className="flex items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-sm font-semibold">
						<ServerCog className="size-3.5" strokeWidth={1.8} />
						Remote servers
					</h2>
					<p className="mt-1 text-[11px] text-muted-foreground">
						Run agents on a different machine — Helmor SSHes in, installs
						<code className="mx-1 rounded bg-muted px-1 py-px font-mono text-[10px]">
							helmor-server
						</code>
						on first connect, and streams events back over the same channel.
					</p>
				</div>
				<Button
					size="sm"
					onClick={() => setWizardOpen(true)}
					data-testid="open-add-remote-server-wizard"
				>
					<Plug2 className="mr-1.5 size-3.5" />
					Add remote server
				</Button>
			</header>

			{runtimesQuery.isLoading ? (
				<p className="text-[11px] text-muted-foreground">Loading…</p>
			) : remotes.length === 0 ? (
				<div
					className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border/40 bg-card/30 px-4 py-6 text-[11px] text-muted-foreground"
					data-testid="remote-servers-empty"
				>
					<span className="font-medium text-foreground">
						No remote servers yet.
					</span>
					<span>
						Add one to run agents on a beefier machine, a cloud dev VM, or any
						other SSH-reachable host.
					</span>
				</div>
			) : (
				<ul className="flex flex-col gap-1.5">
					{remotes.map((entry) => (
						<RemoteServerRow
							key={entry.name}
							entry={entry}
							onDisconnect={() => disconnect.mutate(entry.name)}
							onReconnect={() => reconnect.mutate(entry.name)}
							pending={
								(disconnect.isPending && disconnect.variables === entry.name) ||
								(reconnect.isPending && reconnect.variables === entry.name)
							}
						/>
					))}
				</ul>
			)}

			<AddRemoteServerWizard
				open={wizardOpen}
				onOpenChange={setWizardOpen}
				onConnected={() => {
					void queryClient.invalidateQueries({
						queryKey: ["remote-runtimes"],
					});
				}}
			/>
		</section>
	);
}

function RemoteServerRow({
	entry,
	pending,
	onDisconnect,
	onReconnect,
}: {
	entry: RuntimeEntry;
	pending: boolean;
	onDisconnect: () => void;
	onReconnect: () => void;
}) {
	const stateLabel = formatStateLabel(entry.state);
	const reconnectable = entry.state.type !== "connected";
	return (
		<li
			className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-2"
			data-testid={`remote-server-row-${entry.name}`}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[12px] font-medium">{entry.name}</span>
				<span className="truncate text-[10px] text-muted-foreground">
					{stateLabel}
				</span>
			</div>
			<div className="flex items-center gap-1">
				{reconnectable && (
					<Button
						size="sm"
						variant="ghost"
						disabled={pending}
						onClick={onReconnect}
						data-testid={`remote-server-reconnect-${entry.name}`}
					>
						<Plug className="mr-1.5 size-3" />
						Reconnect
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					disabled={pending}
					onClick={onDisconnect}
					data-testid={`remote-server-disconnect-${entry.name}`}
				>
					Disconnect
				</Button>
			</div>
		</li>
	);
}

function formatStateLabel(state: RuntimeState): string {
	switch (state.type) {
		case "connected":
			return "Connected";
		case "degraded":
			return `Degraded — ${state.reason}`;
		case "disconnected":
			return `Disconnected — ${state.reason}`;
	}
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "Operation failed.";
}
