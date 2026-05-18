import { Folder, FolderPlus, Globe, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mockSidebar } from "./data";
import { WorkspaceGroupHeaderUI } from "./ui/workspace-group-header.ui";
import { WorkspaceRowUI } from "./ui/workspace-row.ui";
import { WorkspaceSidebarShellUI } from "./ui/workspace-sidebar.ui";

/**
 * Onboarding mock sidebar — renders the mockup-private `.ui.tsx` shells
 * (sidebar shell, group header, row) with static mock data. The folder-plus
 * action is wrapped in a Radix DropdownMenu mirroring the real navigation
 * sidebar's "Open project / Clone from URL" affordance, but the items are
 * decorative — they do not invoke real Tauri commands.
 *
 * When `interactive` is false (the default and the case during the very
 * first onboarding frame), the dropdown trigger is disabled so the still
 * preview can't be popped open by a stray click.
 */
export function MockSidebar({
	interactive = false,
	cliSplitSpotlight = false,
}: {
	interactive?: boolean;
	cliSplitSpotlight?: boolean;
}) {
	return (
		<WorkspaceSidebarShellUI
			headerActions={
				<>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								aria-label="Add repository"
								variant="ghost"
								size="icon-xs"
								disabled={!interactive}
								className="text-muted-foreground"
							>
								<FolderPlus className="size-4" strokeWidth={2} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-40">
							<DropdownMenuItem onSelect={(event) => event.preventDefault()}>
								<Folder strokeWidth={2} />
								<span>Open project</span>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={(event) => event.preventDefault()}>
								<Globe strokeWidth={2} />
								<span>Clone from URL</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						type="button"
						aria-label="New workspace"
						variant="ghost"
						size="icon-xs"
						className="text-muted-foreground"
					>
						<Plus className="size-4" strokeWidth={2.4} />
					</Button>
				</>
			}
		>
			<div className="scrollbar-stable mt-2 min-h-0 flex-1 overflow-hidden px-2 pr-1">
				<div className="space-y-2">
					{mockSidebar.groups.map((group) => (
						<div key={group.id} className="space-y-0.5">
							<WorkspaceGroupHeaderUI
								label={group.label}
								count={group.rows.length}
								tone={group.tone}
								isOpen
								canCollapse
							/>
							{group.rows.map((row) => (
								<div
									key={row.id}
									className={
										cliSplitSpotlight && row.cliSplitTarget
											? "relative z-40 isolate rounded-[10px] bg-sidebar pl-2"
											: "pl-2"
									}
								>
									<WorkspaceRowUI
										displayTitle={row.title}
										repoInitials={row.repoInitials}
										repoName={row.title}
										branchTone={row.branchTone}
										hasUnread={row.hasUnread}
										selected={row.isSelected}
										isSending={row.isSending}
										dataWorkspaceRowId={row.id}
									/>
								</div>
							))}
						</div>
					))}
				</div>
			</div>
		</WorkspaceSidebarShellUI>
	);
}
