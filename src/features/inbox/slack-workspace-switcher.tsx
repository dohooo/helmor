import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, Download, Loader2, X } from "lucide-react";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type SlackWorkspace, slackDisconnectWorkspace } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import { InboxActionMenuButton } from "./actions";
import { useSlackImportMutation } from "./slack-connect-button";

/** Single right-side button: shows the active workspace's team name +
 *  chevron, opens a popover with the connected list, an "Add workspace"
 *  row, and per-row disconnect. Mirrors the GitHub repo switcher
 *  pattern in spirit while keeping the surface narrower (no search box —
 *  most users have 1–3 workspaces). */
export function SlackWorkspaceSwitcher({
	workspaces,
	activeTeamId,
	onSelect,
}: {
	workspaces: SlackWorkspace[];
	activeTeamId: string | null;
	onSelect: (teamId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const pushToast = useWorkspaceToast();
	const active = workspaces.find((w) => w.teamId === activeTeamId);

	const importMutation = useSlackImportMutation({
		onImported: (workspace) => {
			onSelect(workspace.teamId);
			setOpen(false);
		},
	});

	const disconnectMutation = useMutation({
		mutationFn: (teamId: string) => slackDisconnectWorkspace(teamId),
		onError: (error) => {
			const message =
				error instanceof Error
					? error.message
					: "Couldn't disconnect Slack workspace.";
			pushToast(message, "Disconnect failed", "destructive");
		},
	});

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<InboxActionMenuButton
					aria-label="Switch Slack workspace"
					className="max-w-[150px]"
				>
					<span className="min-w-0 truncate">
						{active?.teamName ?? "Workspace"}
					</span>
					<ChevronDown className="size-3" strokeWidth={2} />
				</InboxActionMenuButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-[220px]">
				{workspaces.length === 0 ? (
					<div className="px-2 py-1.5 text-mini text-muted-foreground">
						No connected workspaces
					</div>
				) : (
					workspaces.map((ws) => (
						<DropdownMenuItem
							key={ws.teamId}
							onSelect={(event) => {
								event.preventDefault();
								onSelect(ws.teamId);
								setOpen(false);
							}}
							className="flex cursor-interactive items-center justify-between gap-2 text-mini"
						>
							<div className="flex min-w-0 items-center gap-1.5">
								<Check
									className={cn(
										"size-3 shrink-0",
										ws.teamId === activeTeamId ? "opacity-100" : "opacity-0",
									)}
									strokeWidth={2}
								/>
								<span className="truncate">{ws.teamName}</span>
							</div>
							<button
								type="button"
								aria-label={`Disconnect ${ws.teamName}`}
								className="ml-1 inline-flex size-5 cursor-interactive items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
								onClick={(event) => {
									event.stopPropagation();
									disconnectMutation.mutate(ws.teamId);
								}}
							>
								{disconnectMutation.isPending &&
								disconnectMutation.variables === ws.teamId ? (
									<Loader2 className="size-3 animate-spin" strokeWidth={2} />
								) : (
									<X className="size-3" strokeWidth={2} />
								)}
							</button>
						</DropdownMenuItem>
					))
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={(event) => {
						event.preventDefault();
						importMutation.mutate();
					}}
					disabled={importMutation.isPending}
					className="cursor-interactive gap-1.5 text-mini"
				>
					{importMutation.isPending ? (
						<Loader2 className="size-3 animate-spin" strokeWidth={2} />
					) : (
						<Download className="size-3" strokeWidth={2} />
					)}
					{importMutation.isPending
						? "Reading session…"
						: "Connect another workspace"}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
