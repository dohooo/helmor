import { Loader2, Users } from "lucide-react";
import { GithubBrandIcon } from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { initialsFor } from "@/lib/initials";
import type { ParsedInvite } from "@/lib/team-mode";
import { useInviteAccept } from "./use-invite-accept";
import { useTeamIdentity } from "./use-team-identity";

/**
 * Headline invite-accept UX. Shown when the app is opened with a team invite
 * (`?invite=<token>`). Confirms the GitHub identity we'll register, then
 * redeems the token — on success the hook persists the config, flips team
 * mode on, and reloads.
 */
export function InviteAcceptDialog({
	invite,
	onDismiss,
}: {
	invite: ParsedInvite;
	onDismiss: () => void;
}) {
	const { identity, isLoading } = useTeamIdentity();
	const { status, errorMessage, accept } = useInviteAccept();
	const accepting = status === "accepting";
	const displayName = identity?.displayName?.trim() || identity?.login || "";

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				// Don't let an outside-click cancel mid-accept (the reload is
				// imminent); otherwise dismissing just closes the prompt.
				if (!next && !accepting) onDismiss();
			}}
		>
			<DialogContent className="max-w-[420px]">
				<DialogHeader>
					<div className="mb-1 flex size-10 items-center justify-center rounded-full bg-accent">
						<Users className="size-5 text-foreground" strokeWidth={2} />
					</div>
					<DialogTitle>Join the team workspace</DialogTitle>
					<DialogDescription>
						You've been invited to a shared Helmor cloud workspace at{" "}
						<span className="font-medium text-foreground">{invite.url}</span>.
					</DialogDescription>
				</DialogHeader>

				{isLoading ? (
					<div className="flex items-center justify-center gap-2 py-6 text-small text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						Detecting your GitHub account…
					</div>
				) : identity ? (
					<div className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 p-3">
						<div className="relative shrink-0">
							<CachedAvatar
								size="lg"
								className="size-9"
								src={identity.avatarUrl}
								alt={identity.login}
								fallback={initialsFor(displayName)}
								fallbackClassName="bg-muted text-ui font-semibold uppercase text-muted-foreground"
							/>
							<span className="absolute -right-1 -bottom-1 flex size-[16px] items-center justify-center rounded-full bg-background ring-2 ring-background">
								<GithubBrandIcon size={10} />
							</span>
						</div>
						<div className="min-w-0">
							<div className="truncate text-ui font-semibold text-foreground">
								{displayName}
							</div>
							<div className="truncate text-small text-muted-foreground">
								@{identity.login}
							</div>
						</div>
					</div>
				) : (
					<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-small text-muted-foreground">
						No GitHub account is connected. Sign in to GitHub in Settings →
						Accounts, then reopen the invite link.
					</div>
				)}

				{errorMessage ? (
					<p className="text-small text-destructive">{errorMessage}</p>
				) : null}

				<DialogFooter>
					<Button
						variant="ghost"
						onClick={onDismiss}
						disabled={accepting}
						className="cursor-pointer"
					>
						Not now
					</Button>
					<Button
						onClick={() => {
							if (identity) void accept(invite, identity);
						}}
						disabled={!identity || accepting}
						className="cursor-pointer"
					>
						{accepting ? (
							<>
								<Loader2 className="size-3.5 animate-spin" />
								Joining…
							</>
						) : (
							"Join team"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
