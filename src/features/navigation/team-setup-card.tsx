import { Cloud, MailPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTeamSetupStore } from "@/features/navigation/state/team-setup-store";
import { useInviteAccept } from "@/features/team/use-invite-accept";
import { useTeamIdentity } from "@/features/team/use-team-identity";
import { parseInviteLink } from "@/lib/team-mode";
import { TeamCreateFlow } from "./team-create-flow";

/**
 * Team-cloud setup card, shown over a frosted overlay when the user picks Team
 * mode from the workspace-location switch without a configured backend. Two
 * paths:
 *  - Join: paste an invite link → register with the GitHub identity + switch
 *    into the team workspace (reuses the existing invite-accept flow).
 *  - Create: stand up a new team backend on the user's own Cloudflare account
 *    (in-app OAuth + auto-deploy) via {@link TeamCreateFlow}.
 */
export function TeamSetupCard() {
	const open = useTeamSetupStore((s) => s.open);
	const close = useTeamSetupStore((s) => s.close);
	const [view, setView] = useState<"choose" | "create">("choose");
	const [inviteLink, setInviteLink] = useState("");
	const { identity, isLoading: identityLoading } = useTeamIdentity();
	const { status, accept } = useInviteAccept();
	const joining = status === "accepting";

	// Each fresh open starts at the choice screen. The card component stays
	// mounted (it only renders null while closed), so local view state would
	// otherwise persist a stale "create" across opens.
	useEffect(() => {
		if (open) setView("choose");
	}, [open]);

	if (!open) return null;

	const handleJoin = async () => {
		const invite = parseInviteLink(inviteLink);
		if (!invite) {
			toast.error("That doesn't look like a valid invite link");
			return;
		}
		if (!identity) {
			toast.error(
				identityLoading
					? "Still loading your GitHub account — try again in a moment."
					: "Connect a GitHub account first (Settings → Accounts)",
			);
			return;
		}
		// On success the hook persists config + switches into team mode in place.
		const outcome = await accept(invite, identity);
		if (outcome.ok) {
			close();
		} else if (outcome.error) {
			toast.error(outcome.error);
		}
	};

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-xl">
			<div className="relative w-full max-w-md rounded-xl border border-border/50 bg-card/90 p-6 shadow-lg">
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={close}
					aria-label="Close"
					className="absolute top-3 right-3 text-muted-foreground"
				>
					<X className="size-4" />
				</Button>

				{view === "create" ? (
					<TeamCreateFlow onBack={() => setView("choose")} onDone={close} />
				) : (
					<>
						<h2 className="font-semibold text-lg">Set up team cloud</h2>
						<p className="mt-1 text-mini text-muted-foreground leading-tight">
							Run Helmor against a shared cloud backend so your team
							collaborates in the same workspace.
						</p>

						<div className="mt-5 flex flex-col gap-2">
							<div className="flex items-center gap-1.5 font-medium">
								<MailPlus
									className="size-4 text-muted-foreground"
									strokeWidth={1.8}
								/>
								<span>Join a team</span>
							</div>
							<p className="text-mini text-muted-foreground leading-tight">
								Paste the invite link a teammate sent you.
							</p>
							<div className="flex items-center gap-2">
								<Input
									value={inviteLink}
									onChange={(e) => setInviteLink(e.target.value)}
									placeholder="https://…/?invite=…"
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									disabled={joining}
								/>
								<Button
									size="sm"
									onClick={() => void handleJoin()}
									disabled={joining || identityLoading || !inviteLink.trim()}
								>
									{joining ? "Joining…" : "Join"}
								</Button>
							</div>
						</div>

						<div className="my-5 h-px bg-border/50" />

						<div className="flex items-center justify-between gap-3">
							<div className="flex flex-col gap-0.5">
								<div className="flex items-center gap-1.5 font-medium">
									<Cloud
										className="size-4 text-muted-foreground"
										strokeWidth={1.8}
									/>
									<span>Create a team</span>
								</div>
								<p className="text-mini text-muted-foreground leading-tight">
									Stand up a new shared backend on Cloudflare.
								</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setView("create")}
							>
								Create
							</Button>
						</div>

						<div className="mt-5 flex justify-end">
							<Button variant="ghost" size="sm" onClick={close}>
								Cancel
							</Button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
