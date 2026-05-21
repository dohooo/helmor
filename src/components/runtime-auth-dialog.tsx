/**
 * Track G2: per-runtime secret entry dialog.
 *
 * Lets the operator push a provider API key into a specific remote
 * runtime's daemon. Keys flow desktop → daemon over the live RPC
 * connection; the desktop never persists them to its own keychain
 * (that's only for the local runtime). Each runtime maintains its
 * own secrets.json on the remote, so multi-account setups
 * ("dev-stage uses my personal Cursor key, prod uses the team one")
 * are first-class.
 *
 * Single-purpose modal — no provider picker today because the only
 * SDK behind `agent.setAuth` is Cursor; that selector lands when the
 * second provider does.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
	getRemoteRuntimeAuthStatus,
	type ProviderAuthStatus,
	setRuntimeAgentAuth,
} from "@/lib/api";

export type RuntimeAuthDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Runtime name the key belongs to. The local runtime is rejected
	 * by the backend; the caller is expected to gate the affordance. */
	runtimeName: string | null;
	/** Provider key under which the daemon stores the secret.
	 * Defaults to `"cursor"` — change when other providers land. */
	provider?: string;
};

export function RuntimeAuthDialog({
	open,
	onOpenChange,
	runtimeName,
	provider = "cursor",
}: RuntimeAuthDialogProps) {
	const queryClient = useQueryClient();
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");

	// Reset on open so re-opening for the same runtime doesn't leak
	// the previous typed value (worse: keep a half-typed key from a
	// different runtime selection).
	useEffect(() => {
		if (open) {
			setApiKey("");
			setBaseUrl("");
		}
	}, [open]);

	// Track G2 read side: surface what's currently stored on the
	// daemon so the operator can confirm whether a key exists before
	// typing a new one (or know that a Clear actually went through).
	const statusQuery = useQuery({
		queryKey: ["runtime-auth-status", runtimeName],
		queryFn: () =>
			runtimeName ? getRemoteRuntimeAuthStatus(runtimeName) : null,
		enabled: open && runtimeName !== null,
		refetchOnWindowFocus: false,
		staleTime: 5_000,
	});
	const currentStatus: ProviderAuthStatus | null =
		statusQuery.data?.providers.find((p) => p.provider === provider) ?? null;

	const save = useMutation({
		mutationFn: async () => {
			if (!runtimeName) throw new Error("No runtime selected");
			const key = apiKey.trim() === "" ? null : apiKey;
			const base = baseUrl.trim() === "" ? null : baseUrl.trim();
			await setRuntimeAgentAuth(runtimeName, provider, key, base);
		},
		onSuccess: () => {
			toast.success(
				apiKey.trim() === ""
					? `Cleared ${provider} key on ${runtimeName}`
					: `Saved ${provider} key on ${runtimeName}`,
			);
			// Refresh the status query so the row chip flips
			// immediately on close.
			void queryClient.invalidateQueries({
				queryKey: ["runtime-auth-status", runtimeName],
			});
			onOpenChange(false);
		},
		onError: (err) => toast.error(formatError(err)),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="w-[min(85vw,480px)] max-w-[480px] gap-3 p-5"
				data-testid="runtime-auth-dialog"
			>
				<div className="flex items-center justify-between">
					<DialogTitle className="flex items-center gap-2 text-sm font-semibold">
						<KeyRound className="size-3.5" />
						Set {provider} API key
					</DialogTitle>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={() => onOpenChange(false)}
						aria-label="Close runtime-auth dialog"
					>
						<X className="size-3.5" />
					</Button>
				</div>
				<DialogDescription className="text-[11px] text-muted-foreground">
					Pushes the key to{" "}
					<strong className="font-mono">{runtimeName ?? "(no runtime)"}</strong>
					's daemon-side secrets store. The desktop does not persist this value
					— it transits the live SSH pipe and is written to a 0600 file on the
					remote.
				</DialogDescription>
				{currentStatus?.configured ? (
					<div
						className="flex items-start gap-2 rounded-md border border-emerald-700/30 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200"
						data-testid="runtime-auth-status-configured"
					>
						<CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
						<div className="flex flex-col gap-0.5">
							<span>
								<strong className="font-medium">
									{provider} key is currently configured.
								</strong>{" "}
								Leave the field blank below to clear it; type a new key to
								rotate.
							</span>
							{currentStatus.baseUrl ? (
								<span className="font-mono text-[10px] text-emerald-200/70">
									Base URL: {currentStatus.baseUrl}
								</span>
							) : null}
						</div>
					</div>
				) : statusQuery.isSuccess ? (
					<div
						className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground"
						data-testid="runtime-auth-status-not-configured"
					>
						<KeyRound className="mt-0.5 size-3.5 shrink-0 opacity-50" />
						<span>
							No <strong className="font-medium">{provider}</strong> key
							configured on this runtime yet.
						</span>
					</div>
				) : null}
				<div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-3">
					<Label htmlFor="runtime-auth-api-key" className="text-xs">
						API key
					</Label>
					<Input
						id="runtime-auth-api-key"
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="Leave empty to clear the stored key"
						data-testid="runtime-auth-api-key"
					/>
					<Label htmlFor="runtime-auth-base-url" className="text-xs">
						Base URL
					</Label>
					<Input
						id="runtime-auth-base-url"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						placeholder="(Optional) override the provider endpoint"
						data-testid="runtime-auth-base-url"
					/>
				</div>
				<div className="flex justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onOpenChange(false)}
						data-testid="runtime-auth-cancel"
					>
						Cancel
					</Button>
					<Button
						size="sm"
						disabled={!runtimeName || save.isPending}
						onClick={() => save.mutate()}
						data-testid="runtime-auth-save"
					>
						{apiKey.trim() === "" ? "Clear key" : "Save key"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "Failed to update auth.";
}
