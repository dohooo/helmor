import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2, Users } from "lucide-react";
import { CachedAvatar } from "@/components/cached-avatar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { initialsFor } from "@/lib/initials";
import {
	teamMembersQueryOptions,
	teamWorkspacesQueryOptions,
} from "@/lib/query-client";
import type { TeamMember } from "@/lib/team-api";
import type { TeamConfig } from "@/lib/team-mode";
import { getTeamConfig, isTeamModeActive } from "@/lib/team-mode";

/**
 * Sidebar team panel — rendered above the workspace list ONLY in team mode.
 * Shows the real roster (`GET /team/members`, small avatars) and the shared
 * sandbox's workspaces (`GET /team/workspaces`). In local single-user mode
 * this renders `null`, so the sidebar is unchanged.
 *
 * This outer gate calls NO hooks and returns `null` outside team mode, so
 * the React Query reads (in {@link TeamSectionContent}) never mount in the
 * local single-user path — sidebar consumers that render without a
 * QueryClientProvider (e.g. standalone sidebar tests) stay unaffected.
 */
export function TeamSection({
	onOpenWorkspace,
}: {
	/** Open a shared workspace by its sandbox id (== `ws.id`). Threaded from
	 *  the sidebar's `onSelectWorkspace`, so a click routes through the same
	 *  selection path as the local workspace list. */
	onOpenWorkspace?: (id: string) => void;
}) {
	const cfg = isTeamModeActive() ? getTeamConfig() : null;
	if (!cfg) return null;
	return <TeamSectionContent cfg={cfg} onOpenWorkspace={onOpenWorkspace} />;
}

function TeamSectionContent({
	cfg,
	onOpenWorkspace,
}: {
	cfg: TeamConfig;
	onOpenWorkspace?: (id: string) => void;
}) {
	const membersQuery = useQuery(teamMembersQueryOptions(cfg));
	const workspacesQuery = useQuery(teamWorkspacesQueryOptions(cfg));

	const members = membersQuery.data ?? [];
	const workspaces = workspacesQuery.data ?? [];
	const loading = membersQuery.isPending || workspacesQuery.isPending;
	const errored = membersQuery.isError || workspacesQuery.isError;

	return (
		<div className="mt-2 border-b border-border/40 px-3 pb-3">
			<div className="flex items-center justify-between py-1">
				<span className="flex items-center gap-1.5 text-title font-medium text-muted-foreground">
					<Users className="size-[14px]" strokeWidth={2} />
					Team
				</span>
				{loading ? (
					<Loader2 className="size-3 animate-spin text-muted-foreground" />
				) : errored ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								className="flex cursor-default items-center text-destructive"
								aria-label="Team data failed to load"
							>
								<CircleAlert className="size-3.5" strokeWidth={2.2} />
							</span>
						</TooltipTrigger>
						<TooltipContent side="top" className="text-mini">
							Couldn't reach the team backend.
						</TooltipContent>
					</Tooltip>
				) : (
					<MemberAvatars members={members} />
				)}
			</div>

			{workspaces.length > 0 ? (
				<ul className="mt-1 space-y-0.5">
					{workspaces.map((ws) => (
						<li key={ws.id}>
							<div
								role="button"
								tabIndex={0}
								className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-ui text-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
								onClick={() => onOpenWorkspace?.(ws.id)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										onOpenWorkspace?.(ws.id);
									}
								}}
							>
								<span className="truncate">{ws.name}</span>
								<span className="ml-auto shrink-0 text-mini text-muted-foreground/70">
									{ws.status}
								</span>
							</div>
						</li>
					))}
				</ul>
			) : !loading && !errored ? (
				<p className="mt-1 px-1.5 text-mini text-muted-foreground/70">
					No shared workspaces yet.
				</p>
			) : null}
		</div>
	);
}

/** Overlapping avatar stack of team members, capped with a "+N" pill. */
function MemberAvatars({ members }: { members: TeamMember[] }) {
	if (members.length === 0) {
		return (
			<span className="text-mini text-muted-foreground/70">No members</span>
		);
	}
	const MAX = 5;
	const shown = members.slice(0, MAX);
	const overflow = members.length - shown.length;
	return (
		<div className="flex items-center">
			<div className="flex -space-x-1.5">
				{shown.map((member) => {
					const name = member.display_name?.trim() || member.github_login;
					return (
						<Tooltip key={member.id}>
							<TooltipTrigger asChild>
								<span className="ring-2 ring-sidebar">
									<CachedAvatar
										className="size-5"
										src={member.avatar_url}
										alt={member.github_login}
										fallback={initialsFor(name)}
										fallbackClassName="bg-muted text-[8px] font-semibold uppercase text-muted-foreground"
									/>
								</span>
							</TooltipTrigger>
							<TooltipContent side="top" className="text-mini">
								{name}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
			{overflow > 0 ? (
				<span className="ml-1 text-mini text-muted-foreground/70">
					+{overflow}
				</span>
			) : null}
		</div>
	);
}
