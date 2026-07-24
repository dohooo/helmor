import { useMutation } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { mintInvite } from "@/lib/team-api";
import { getTeamAdminToken, getTeamConfig } from "@/lib/team-mode";

/** Invite links are one-time capabilities; give them a week to be redeemed. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The invite modal (R5-A) — replaces the old Settings → Team "Mint invite"
 * row. "Done for you": opening the modal mints a link immediately (no
 * separate Mint click), shows it with Copy, and offers a low-key "New link".
 * Minting authenticates with the ADMIN token (stored on the creator's
 * machine at create time) — the everyday member bearer can't mint.
 *
 * The link is a capability secret: it lives only in mutation state, is
 * rendered only inside this modal, and is never logged.
 */
export function InviteModal({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<number | null>(null);

	const mint = useMutation({
		mutationFn: () => {
			const cfg = getTeamConfig();
			const adminToken = getTeamAdminToken();
			if (!cfg || !adminToken) {
				return Promise.reject(
					new Error("Only the team creator can mint invites."),
				);
			}
			return mintInvite(
				{ url: cfg.url, token: adminToken },
				{ expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() },
			);
		},
	});

	// Auto-mint on open; reset on close so each open gets a fresh link.
	const { mutate, reset } = mint;
	useEffect(() => {
		if (open) {
			mutate();
		} else {
			reset();
			setCopied(false);
		}
	}, [open, mutate, reset]);

	useEffect(() => {
		return () => {
			if (copiedTimer.current !== null) {
				window.clearTimeout(copiedTimer.current);
			}
		};
	}, []);

	const handleCopy = async (url: string) => {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			if (copiedTimer.current !== null) {
				window.clearTimeout(copiedTimer.current);
			}
			copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard denied — the link stays selectable in the box.
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[400px] gap-0 p-5">
				<DialogTitle className="text-ui font-semibold">
					Invite a teammate
				</DialogTitle>
				<DialogDescription className="mt-1.5 text-small leading-relaxed text-muted-foreground">
					Send this link — they paste it into Helmor and join instantly with
					their GitHub account.
				</DialogDescription>

				{mint.isPending ? (
					<div className="mt-4 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 text-small text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						Creating an invite link…
					</div>
				) : null}

				{mint.isError ? (
					<div className="mt-4 flex flex-col items-start gap-2">
						<p className="text-small text-status-danger leading-snug">
							{mint.error instanceof Error
								? mint.error.message
								: "Couldn't create an invite link."}
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => mint.mutate()}
							className="cursor-pointer"
						>
							Retry
						</Button>
					</div>
				) : null}

				{mint.data ? (
					<>
						<div className="mt-4 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 py-1.5 pr-1.5 pl-3">
							<input
								readOnly
								value={mint.data.url}
								aria-label="Invite link"
								onFocus={(event) => event.currentTarget.select()}
								className="min-w-0 flex-1 bg-transparent font-mono text-mini text-foreground outline-none"
							/>
							<Button
								size="sm"
								onClick={() => void handleCopy(mint.data.url)}
								className="shrink-0 cursor-pointer"
							>
								{copied ? <Check className="size-3.5" /> : null}
								{copied ? "Copied" : "Copy"}
							</Button>
						</div>
						<p className="mt-2.5 text-mini text-muted-foreground">
							One-time link · expires in 7 days
						</p>
						<div className="mt-4 flex justify-end border-t border-border/40 pt-3">
							<button
								type="button"
								onClick={() => mint.mutate()}
								className="cursor-pointer text-mini text-muted-foreground hover:text-foreground hover:underline"
							>
								New link
							</button>
						</div>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
