import { useQuery } from "@tanstack/react-query";
import {
	ChevronDown,
	MessageCircle,
	MoreHorizontal,
	Pause,
	Pencil,
	Play,
	Trash2,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Automation } from "@/lib/api";
import { automationsQueryOptions } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { AutomationDetail } from "./automation-detail";
import { CreateAutomationDialog } from "./create-automation-dialog";
import {
	scheduleShortLabel,
	scheduleSummary,
	statusDotClass,
} from "./schedule";
import { useAutomationMutations } from "./use-automation-mutations";

function CreateSplitButton({
	onCreateViaChat,
	onCreateManually,
}: {
	onCreateViaChat: () => void;
	onCreateManually: () => void;
}) {
	return (
		<ButtonGroup>
			<Button size="sm" onClick={onCreateViaChat}>
				Create via chat
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size="sm" aria-label="More create options" className="px-1.5">
						<ChevronDown />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onSelect={onCreateViaChat}>
						<MessageCircle />
						Create via chat
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onCreateManually}>
						<Pencil />
						Create manually
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</ButtonGroup>
	);
}

function AutomationRow({
	automation,
	onOpen,
	onRunNow,
	onToggleStatus,
	onDelete,
}: {
	automation: Automation;
	onOpen: () => void;
	onRunNow: () => void;
	onToggleStatus: () => void;
	onDelete: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const paused = automation.status === "paused";
	const subtitle = `${scheduleSummary(automation.schedule)} · ${automation.prompt.replace(/\s+/g, " ")}`;

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpen();
				}
			}}
			className="group flex cursor-pointer items-center gap-3 border-b border-border/60 px-1 py-3.5 transition-colors hover:bg-muted/30"
		>
			<span
				aria-hidden
				className={cn(
					"size-2 shrink-0 rounded-full",
					statusDotClass(automation.status),
				)}
			/>
			<div className="min-w-0 flex-1">
				<div className="truncate text-body font-semibold text-foreground">
					{automation.title}
				</div>
				<div className="truncate text-ui text-muted-foreground">{subtitle}</div>
			</div>
			<span className="shrink-0 text-ui text-muted-foreground">
				{scheduleShortLabel(automation.schedule)}
			</span>
			<div
				className={cn(
					"flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
					menuOpen && "opacity-100",
				)}
			>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Run now"
					onClick={(event) => {
						event.stopPropagation();
						onRunNow();
					}}
				>
					<Play />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Edit automation"
					onClick={(event) => {
						event.stopPropagation();
						onOpen();
					}}
				>
					<Pencil />
				</Button>
				<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="More actions"
							onClick={(event) => event.stopPropagation()}
						>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						onClick={(event) => event.stopPropagation()}
					>
						<DropdownMenuItem onSelect={onToggleStatus}>
							{paused ? <Play /> : <Pause />}
							{paused ? "Resume" : "Pause"}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onSelect={onDelete}>
							<Trash2 />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}

export function AutomationsSurface({
	onOpenSession,
	onCreateViaChat,
}: {
	/** Navigate the app to a chat (used after Run now). */
	onOpenSession: (workspaceId: string, sessionId: string) => void;
	/** "Create via chat" — shell opens a new chat with a prefilled prompt. */
	onCreateViaChat: () => void;
}): ReactElement {
	const [detailId, setDetailId] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);

	const automationsQuery = useQuery(automationsQueryOptions());
	const automations = automationsQuery.data ?? [];
	const { remove, setStatus, runNow } = useAutomationMutations();

	const runAndOpen = (automation: Automation) => {
		runNow.mutate(automation.id, {
			onSuccess: (sessionId) => {
				// Workspace-mode runs open the fresh session; chat-mode runs
				// append to a chat elsewhere, so confirm instead of jumping.
				if (automation.workspaceId) {
					onOpenSession(automation.workspaceId, sessionId);
				} else {
					toast.success("Automation started", {
						description: "Running in its chat.",
					});
				}
			},
		});
	};

	const detail =
		detailId !== null
			? automations.find((automation) => automation.id === detailId)
			: undefined;
	if (detail) {
		return (
			<AutomationDetail
				key={detail.id}
				automation={detail}
				onBack={() => setDetailId(null)}
				onOpenSession={onOpenSession}
			/>
		);
	}

	return (
		<div className="h-full overflow-y-auto bg-background">
			<div className="mx-auto w-full max-w-3xl px-8 py-10">
				<div className="flex items-start justify-between gap-4">
					<h1 className="text-heading font-semibold text-foreground">
						Automations
					</h1>
					<CreateSplitButton
						onCreateViaChat={onCreateViaChat}
						onCreateManually={() => setCreateOpen(true)}
					/>
				</div>

				<div className="mt-10">
					<h2 className="border-b border-border pb-2 text-ui font-medium text-muted-foreground">
						Current
					</h2>
					{automationsQuery.isPending ? (
						<p className="py-6 text-ui text-muted-foreground">Loading…</p>
					) : automationsQuery.isError ? (
						<p className="py-6 text-ui text-muted-foreground">
							Unable to load automations.
						</p>
					) : automations.length === 0 ? (
						<div className="flex flex-col items-start gap-3 py-8">
							<p className="text-ui text-muted-foreground">
								No automations yet. Schedule a recurring prompt and it will run
								on its own.
							</p>
							<Button size="sm" onClick={() => setCreateOpen(true)}>
								Create automation
							</Button>
						</div>
					) : (
						automations.map((automation) => (
							<AutomationRow
								key={automation.id}
								automation={automation}
								onOpen={() => setDetailId(automation.id)}
								onRunNow={() => runAndOpen(automation)}
								onToggleStatus={() =>
									setStatus.mutate({
										automationId: automation.id,
										status:
											automation.status === "paused" ? "active" : "paused",
									})
								}
								onDelete={() => setPendingDelete(automation)}
							/>
						))
					)}
				</div>
			</div>

			<CreateAutomationDialog open={createOpen} onOpenChange={setCreateOpen} />
			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
				title="Delete automation?"
				description={
					pendingDelete
						? `"${pendingDelete.title}" will stop running and be removed. This cannot be undone.`
						: ""
				}
				confirmLabel="Delete"
				loading={remove.isPending}
				onConfirm={() => {
					if (!pendingDelete) return;
					remove.mutate(pendingDelete.id, {
						onSuccess: () => setPendingDelete(null),
					});
				}}
			/>
		</div>
	);
}
