/**
 * Tracks B3 + B4: render a compact "what does ssh see?" panel for
 * the Add-Server wizard and Remote Servers settings section. Two
 * subrows:
 *
 *   1. SSH agent chip — three states (`available` / `notConfigured` /
 *      `stale`) so a user without `SSH_AUTH_SOCK` exported sees the
 *      problem without diving into stderr.
 *   2. Identity-keys hint — the file stems of keys the desktop can
 *      see in `~/.ssh`. Informational only; we don't let the operator
 *      pick which one ssh uses (that's `~/.ssh/config`'s job).
 *
 * Both queries are cheap (synchronous Tauri calls, no network) so
 * we refresh on every modal open. Errors fall through to "no data"
 * — the rest of the wizard stays usable.
 */

import { useQuery } from "@tanstack/react-query";
import {
	KeyRound,
	ShieldAlert,
	ShieldCheck,
	ShieldQuestion,
} from "lucide-react";
import {
	getSshAgentStatus,
	listSshIdentities,
	type SshAgentStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export type SshDiagnosticsProps = {
	/**
	 * Only fetch while the parent surface is visible. Both queries are
	 * cheap but skipping them while the modal is closed keeps the
	 * Tauri command count tighter at app start.
	 */
	enabled?: boolean;
};

export function SshDiagnostics({ enabled = true }: SshDiagnosticsProps) {
	const agentQuery = useQuery({
		queryKey: ["ssh-agent-status"],
		queryFn: getSshAgentStatus,
		enabled,
		refetchOnWindowFocus: false,
		staleTime: 5_000,
	});
	const identitiesQuery = useQuery({
		queryKey: ["ssh-identities"],
		queryFn: listSshIdentities,
		enabled,
		refetchOnWindowFocus: false,
		staleTime: 30_000,
	});

	return (
		<div
			className="flex flex-col gap-2 rounded-md border border-border/40 bg-muted/30 p-3 text-[11px]"
			data-testid="ssh-diagnostics"
		>
			<AgentChip
				status={agentQuery.data ?? null}
				isLoading={agentQuery.isLoading}
			/>
			<IdentitiesRow
				identities={identitiesQuery.data ?? []}
				isLoading={identitiesQuery.isLoading}
			/>
		</div>
	);
}

function AgentChip({
	status,
	isLoading,
}: {
	status: SshAgentStatus | null;
	isLoading: boolean;
}) {
	if (isLoading) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground">
				<ShieldQuestion className="size-3.5 opacity-50" />
				<span>Checking SSH agent…</span>
			</div>
		);
	}
	if (!status) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground">
				<ShieldQuestion className="size-3.5 opacity-50" />
				<span>SSH agent status unavailable.</span>
			</div>
		);
	}
	if (status.state === "available") {
		const keyText =
			status.keysLoaded === 1
				? "1 key loaded"
				: `${status.keysLoaded} keys loaded`;
		return (
			<div
				className="flex items-center gap-2 text-emerald-300"
				data-testid="ssh-agent-chip-available"
				title={status.socketPath}
			>
				<ShieldCheck className="size-3.5" />
				<span>
					SSH agent reachable —{" "}
					<strong className="font-medium">{keyText}</strong>.
				</span>
			</div>
		);
	}
	if (status.state === "notConfigured") {
		return (
			<div
				className={cn(
					"flex items-start gap-2 text-amber-300",
					"[&>svg]:mt-0.5",
				)}
				data-testid="ssh-agent-chip-not-configured"
			>
				<ShieldQuestion className="size-3.5 shrink-0" />
				<span>
					<strong className="font-medium">SSH agent not detected.</strong>{" "}
					Launch Helmor from a shell that exports{" "}
					<code className="rounded bg-background/40 px-1 py-px font-mono">
						SSH_AUTH_SOCK
					</code>{" "}
					— ssh will still try identity files in <code>~/.ssh</code>.
				</span>
			</div>
		);
	}
	// stale
	return (
		<div
			className={cn("flex items-start gap-2 text-rose-300", "[&>svg]:mt-0.5")}
			data-testid="ssh-agent-chip-stale"
			title={status.reason}
		>
			<ShieldAlert className="size-3.5 shrink-0" />
			<span>
				<strong className="font-medium">SSH agent socket is stale.</strong> The
				agent that wrote{" "}
				<code className="rounded bg-background/40 px-1 py-px font-mono">
					{status.socketPath}
				</code>{" "}
				no longer answers. Re-launch the desktop from a fresh shell.
			</span>
		</div>
	);
}

function IdentitiesRow({
	identities,
	isLoading,
}: {
	identities: { name: string; hasPrivateKey: boolean }[];
	isLoading: boolean;
}) {
	if (isLoading) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground">
				<KeyRound className="size-3.5 opacity-50" />
				<span>Scanning ~/.ssh…</span>
			</div>
		);
	}
	if (identities.length === 0) {
		return (
			<div
				className="flex items-center gap-2 text-muted-foreground"
				data-testid="ssh-identities-empty"
			>
				<KeyRound className="size-3.5 opacity-50" />
				<span>
					No keys in <code>~/.ssh</code>. Generate one with{" "}
					<code className="rounded bg-background/40 px-1 py-px font-mono">
						ssh-keygen
					</code>{" "}
					or add a working identity to <code>~/.ssh/config</code>.
				</span>
			</div>
		);
	}
	// Truncate to first 4 to keep the wizard tidy; full list lives in the
	// tooltip via the `title` attribute. Most operators have ≤ 4 keys.
	const visible = identities.slice(0, 4);
	const overflow = identities.length - visible.length;
	return (
		<div
			className="flex items-start gap-2 text-foreground/80"
			data-testid="ssh-identities-row"
		>
			<KeyRound className="mt-0.5 size-3.5 shrink-0" />
			<span className="flex flex-wrap items-center gap-1.5">
				<span className="text-muted-foreground">Keys:</span>
				{visible.map((id) => (
					<span
						key={id.name}
						className={cn(
							"rounded bg-background/40 px-1.5 py-px font-mono text-[10px]",
							id.hasPrivateKey ? "text-foreground" : "text-amber-300",
						)}
						title={
							id.hasPrivateKey
								? id.name
								: `${id.name} — public key only, missing private`
						}
					>
						{id.name}
					</span>
				))}
				{overflow > 0 && (
					<span
						className="text-muted-foreground"
						title={identities
							.slice(visible.length)
							.map((id) => id.name)
							.join(", ")}
					>
						+{overflow} more
					</span>
				)}
			</span>
		</div>
	);
}
