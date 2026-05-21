/**
 * Track B (setup UX): production-accessible "Add Remote Server"
 * wizard. Two-step modal:
 *
 *   1. Name + SSH host (with autocomplete from `~/.ssh/config`).
 *   2. Connect: probes the host, surfaces handshake / install progress,
 *      and reports success / failure.
 *
 * Replaces the dev-gated Runtime Debug panel's connect form as the
 * canonical onboarding path. Triggered from
 * `RemoteServersPanel` (production-visible settings section).
 *
 * The wizard intentionally does NOT expose every transport knob —
 * Command-mode (Teleport, Tailscale, kubectl exec) + Local-binary
 * connections stay in the dev panel for now. The 80% case is plain
 * SSH; this surface is tuned for that.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { Network, Plug2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SshDiagnostics } from "@/components/ssh-diagnostics";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	connectRemoteRuntime,
	listSshHostDetails,
	listSshHosts,
	type SshHostDetail,
} from "@/lib/api";

export type AddRemoteServerWizardProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Fired with the freshly-connected runtime name + host after the
	 * second step succeeds. Lets the host panel refresh its list /
	 * focus the new row without re-querying.
	 */
	onConnected?: (info: { name: string; host: string }) => void;
};

type WizardStep = "form" | "connecting" | "done" | "error";

const DEFAULT_REMOTE_BINARY = "$HOME/.helmor/server/helmor-server";

export function AddRemoteServerWizard({
	open,
	onOpenChange,
	onConnected,
}: AddRemoteServerWizardProps) {
	const [name, setName] = useState("");
	const [host, setHost] = useState("");
	const [forwardAgent, setForwardAgent] = useState(false);
	const [step, setStep] = useState<WizardStep>("form");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Reset on open so the modal always starts at step 1 with empty
	// inputs — re-opening after a successful connect should feel like
	// a fresh start, not a residue of the last session.
	useEffect(() => {
		if (open) {
			setName("");
			setHost("");
			setForwardAgent(false);
			setStep("form");
			setErrorMessage(null);
		}
	}, [open]);

	const sshHostsQuery = useQuery({
		queryKey: ["ssh-hosts"],
		queryFn: listSshHosts,
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
		// Only fetch while the modal is open — `~/.ssh/config` is
		// cheap to parse, but skipping the call when the wizard is
		// closed keeps the Tauri command count tighter on app start.
		enabled: open,
	});
	const sshHosts: string[] = sshHostsQuery.data ?? [];

	// Track B2: per-host attribute snapshot. Separate query so the
	// older `listSshHosts` callers (anything reading the bare alias
	// list) keep working unchanged.
	const sshHostDetailsQuery = useQuery({
		queryKey: ["ssh-host-details"],
		queryFn: listSshHostDetails,
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
		enabled: open,
	});
	const matchedDetail = useMemo<SshHostDetail | null>(() => {
		const target = host.trim();
		if (!target) return null;
		const details = sshHostDetailsQuery.data ?? [];
		// Trim a leading `user@` so an operator who types
		// `dwork@dev.box` still matches a `Host dev.box` block.
		const tail = target.includes("@") ? target.split("@", 2)[1] : target;
		return details.find((d) => d.alias === tail) ?? null;
	}, [host, sshHostDetailsQuery.data]);

	const connect = useMutation({
		mutationFn: async () => {
			const trimmedName = name.trim();
			const trimmedHost = host.trim();
			if (!trimmedName) throw new Error("Name must not be empty");
			if (!trimmedHost) throw new Error("Host must not be empty");
			return connectRemoteRuntime(
				trimmedName,
				trimmedHost,
				DEFAULT_REMOTE_BINARY,
				{ forwardAgent },
			);
		},
		onMutate: () => {
			setErrorMessage(null);
			setStep("connecting");
		},
		onSuccess: () => {
			setStep("done");
			toast.success(`Connected to ${host.trim()}`);
			onConnected?.({ name: name.trim(), host: host.trim() });
		},
		onError: (err) => {
			setErrorMessage(formatError(err));
			setStep("error");
		},
	});

	const formValid = name.trim().length > 0 && host.trim().length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="w-[min(85vw,520px)] max-w-[520px] gap-3 p-5"
				data-testid="add-remote-server-wizard"
			>
				<div className="flex items-center justify-between">
					<DialogTitle className="text-sm font-semibold">
						Add remote server
					</DialogTitle>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={() => onOpenChange(false)}
						aria-label="Close add-remote-server"
					>
						<X className="size-3.5" />
					</Button>
				</div>

				{step === "form" && (
					<>
						<DialogDescription className="text-[11px] text-muted-foreground">
							Helmor will SSH to the host and install
							<code className="mx-1 rounded bg-muted px-1 py-px font-mono text-[10px]">
								helmor-server
							</code>
							if missing. SSH keys + agent forwarding flow through your existing
							<code className="mx-1 rounded bg-muted px-1 py-px font-mono text-[10px]">
								~/.ssh/config
							</code>
							— this wizard does not capture credentials.
						</DialogDescription>
						<div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">
							<Label htmlFor="add-remote-name" className="text-xs">
								Name
							</Label>
							<Input
								id="add-remote-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="dev-stage"
								data-testid="add-remote-server-name"
							/>
							<Label htmlFor="add-remote-host" className="text-xs">
								SSH host
							</Label>
							<Input
								id="add-remote-host"
								list="add-remote-server-host-suggestions"
								value={host}
								onChange={(e) => setHost(e.target.value)}
								placeholder="user@dev.example.com or an ~/.ssh/config alias"
								data-testid="add-remote-server-host"
							/>
							{sshHosts.length > 0 && (
								<datalist id="add-remote-server-host-suggestions">
									{sshHosts.map((h) => (
										<option key={h} value={h} />
									))}
								</datalist>
							)}
						</div>
						{matchedDetail && <HostDetailPreview detail={matchedDetail} />}
						<label
							className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 p-3 text-[11px] hover:bg-muted/50"
							data-testid="add-remote-server-forward-agent"
						>
							<input
								type="checkbox"
								className="mt-0.5"
								checked={forwardAgent}
								onChange={(e) => setForwardAgent(e.target.checked)}
								data-testid="add-remote-server-forward-agent-input"
							/>
							<span className="flex flex-col gap-0.5">
								<span className="font-medium">
									Forward SSH agent
									<span className="ml-1 rounded bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground">
										-o ForwardAgent=yes
									</span>
								</span>
								<span className="text-muted-foreground">
									Required if you want the remote daemon to run{" "}
									<code className="font-mono">git fetch</code> /{" "}
									<code className="font-mono">git push</code> against private
									repos using your local SSH keys. Skip if the remote already
									has its own deploy key.
								</span>
							</span>
						</label>
						<SshDiagnostics enabled={open} />
						<div className="flex justify-end gap-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => onOpenChange(false)}
								data-testid="add-remote-server-cancel"
							>
								Cancel
							</Button>
							<Button
								size="sm"
								disabled={!formValid}
								onClick={() => connect.mutate()}
								data-testid="add-remote-server-connect"
							>
								<Plug2 className="mr-1.5 size-3.5" />
								Connect
							</Button>
						</div>
					</>
				)}

				{step === "connecting" && (
					<div
						className="flex flex-col gap-2 py-4 text-center text-[12px] text-muted-foreground"
						data-testid="add-remote-server-connecting"
					>
						<span className="font-medium text-foreground">
							Connecting to {host.trim()}…
						</span>
						<span>Probing SSH, installing helmor-server if missing.</span>
						<span className="mt-2 inline-flex items-center justify-center gap-2 text-[11px]">
							<span
								className="size-1.5 animate-pulse rounded-full bg-amber-400"
								aria-hidden
							/>
							This may take a few seconds the first time.
						</span>
					</div>
				)}

				{step === "done" && (
					<>
						<div
							className="flex flex-col gap-1 rounded-md border border-emerald-700/30 bg-emerald-500/5 p-3 text-[12px] text-emerald-200"
							data-testid="add-remote-server-success"
						>
							<span className="font-medium text-emerald-100">
								{name.trim()} is live.
							</span>
							<span className="text-emerald-200/80">
								You can now bind workspaces to this runtime.
							</span>
						</div>
						<div className="flex justify-end">
							<Button size="sm" onClick={() => onOpenChange(false)}>
								Done
							</Button>
						</div>
					</>
				)}

				{step === "error" && (
					<>
						<div
							className="flex flex-col gap-1 rounded-md border border-rose-700/30 bg-rose-500/5 p-3 text-[12px] text-rose-200"
							data-testid="add-remote-server-error"
						>
							<span className="font-medium text-rose-100">Connect failed.</span>
							<span className="break-words text-rose-200/80">
								{errorMessage ?? "Unknown error."}
							</span>
						</div>
						<div className="flex justify-end gap-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setStep("form")}
								data-testid="add-remote-server-back"
							>
								Back
							</Button>
							<Button
								size="sm"
								onClick={() => connect.mutate()}
								data-testid="add-remote-server-retry"
							>
								Retry
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "Connect failed.";
}

/// Track B2: read-only summary of what `~/.ssh/config` actually
/// applies for the typed alias. Lets the operator catch
/// "wrong-bastion" / "wrong-user" misconfigs before clicking
/// Connect. Hidden when the typed host isn't an aliased Host block.
function HostDetailPreview({ detail }: { detail: SshHostDetail }) {
	const rows: { label: string; value: string }[] = [];
	if (detail.hostName) rows.push({ label: "HostName", value: detail.hostName });
	if (detail.user) rows.push({ label: "User", value: detail.user });
	if (detail.identityFiles.length > 0) {
		rows.push({
			label:
				detail.identityFiles.length === 1 ? "IdentityFile" : "IdentityFiles",
			value: detail.identityFiles.join(", "),
		});
	}
	if (detail.proxyJump) {
		rows.push({ label: "ProxyJump", value: detail.proxyJump });
	}
	if (rows.length === 0) return null;
	return (
		<div
			className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 p-3 text-[11px]"
			data-testid="add-remote-server-host-detail"
		>
			<Network className="mt-0.5 size-3.5 shrink-0 text-foreground/60" />
			<div className="flex flex-col gap-0.5">
				<span className="text-muted-foreground">
					From <code className="font-mono">~/.ssh/config</code>:
				</span>
				{rows.map((r) => (
					<span
						key={r.label}
						className="font-mono text-[10px] text-foreground/80"
					>
						<span className="text-muted-foreground">{r.label}</span> {r.value}
					</span>
				))}
			</div>
		</div>
	);
}
