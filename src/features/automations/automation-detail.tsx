import { ChevronRight, Pause, Play, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/textarea";
import type { Automation } from "@/lib/api";
import { cn } from "@/lib/utils";
import { IntervalPicker } from "./interval-picker";
import { formatRunTime, statusDotClass, statusLabel } from "./schedule";
import { useAutomationMutations } from "./use-automation-mutations";
import {
	useSessionOptions,
	useWorkspaceOptions,
} from "./use-automation-targets";

function SidebarGroup({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<div>
			<h3 className="text-mini font-medium tracking-wide text-muted-foreground uppercase">
				{title}
			</h3>
			<div className="mt-2 flex flex-col gap-1.5">{children}</div>
		</div>
	);
}

function SidebarRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-7 items-center justify-between gap-3">
			<span className="shrink-0 text-ui text-muted-foreground">{label}</span>
			<span className="flex min-w-0 items-center gap-1.5 text-ui text-foreground">
				{children}
			</span>
		</div>
	);
}

/** In-page detail view (no route). Mounted with `key={automation.id}` so the
 *  title/prompt drafts reset whenever a different automation opens. */
export function AutomationDetail({
	automation,
	onBack,
	onOpenSession,
}: {
	automation: Automation;
	onBack: () => void;
	onOpenSession: (workspaceId: string, sessionId: string) => void;
}) {
	const [titleDraft, setTitleDraft] = useState(automation.title);
	const [promptDraft, setPromptDraft] = useState(automation.prompt);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const { update, remove, setStatus, runNow } = useAutomationMutations();
	const workspaces = useWorkspaceOptions();
	const sessions = useSessionOptions(
		automation.runsIn === "chat" ? automation.workspaceId : null,
	);

	const workspaceName = automation.workspaceId
		? (workspaces.find((workspace) => workspace.id === automation.workspaceId)
				?.title ?? "Unknown workspace")
		: "—";
	const sessionName = automation.sessionId
		? (sessions.find((session) => session.id === automation.sessionId)?.title ??
			"Unknown chat")
		: "—";

	const promptDirty = promptDraft !== automation.prompt;
	const paused = automation.status === "paused";

	const saveTitle = () => {
		const next = titleDraft.trim();
		if (next === "" || next === automation.title) {
			setTitleDraft(automation.title);
			return;
		}
		update.mutate({ id: automation.id, title: next });
	};

	const savePrompt = () => {
		if (!promptDirty || promptDraft.trim() === "") return;
		update.mutate({ id: automation.id, prompt: promptDraft.trim() });
	};

	const handleRunNow = () => {
		runNow.mutate(automation.id, {
			onSuccess: (sessionId) => {
				// Workspace-mode runs land in a fresh session we can jump to;
				// chat-mode runs append to a chat elsewhere, so just confirm.
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

	return (
		<div className="h-full overflow-y-auto bg-background">
			<div className="mx-auto w-full max-w-4xl px-8 py-8">
				<div className="flex items-center justify-between gap-4">
					<nav className="flex min-w-0 items-center gap-1 text-ui">
						<button
							type="button"
							onClick={onBack}
							className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
						>
							Automations
						</button>
						<ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
						<span className="truncate font-medium text-foreground">
							{automation.title}
						</span>
					</nav>
					<div className="flex shrink-0 items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={paused ? "Resume automation" : "Pause automation"}
							onClick={() =>
								setStatus.mutate({
									automationId: automation.id,
									status: paused ? "active" : "paused",
								})
							}
						>
							{paused ? <Play /> : <Pause />}
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Delete automation"
							className="text-muted-foreground hover:text-destructive"
							onClick={() => setConfirmDelete(true)}
						>
							<Trash2 />
						</Button>
						<Button
							size="sm"
							className="ml-1"
							disabled={runNow.isPending}
							onClick={handleRunNow}
						>
							<Play data-icon="inline-start" />
							Run now
						</Button>
					</div>
				</div>

				<div className="mt-8 flex flex-col gap-10 md:flex-row">
					<div className="min-w-0 flex-1">
						<input
							value={titleDraft}
							onChange={(event) => setTitleDraft(event.target.value)}
							onBlur={saveTitle}
							aria-label="Automation title"
							className="w-full bg-transparent text-heading font-semibold text-foreground outline-none placeholder:text-muted-foreground/60"
						/>
						<Textarea
							value={promptDraft}
							onChange={(event) => setPromptDraft(event.target.value)}
							onBlur={savePrompt}
							aria-label="Automation prompt"
							placeholder="Add prompt e.g. look for crashes in $sentry"
							className="mt-4 min-h-48 resize-none border-0 px-0 py-0 text-body leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
						/>
						{promptDirty ? (
							<Button
								size="sm"
								variant="outline"
								className="mt-2"
								disabled={update.isPending || promptDraft.trim() === ""}
								onClick={savePrompt}
							>
								Save
							</Button>
						) : null}
					</div>

					<aside className="w-full shrink-0 md:w-64">
						<div className="flex flex-col gap-6 rounded-xl border border-border p-4">
							<SidebarGroup title="Status">
								<SidebarRow label="Status">
									<span
										className={cn(
											"size-2 rounded-full",
											statusDotClass(automation.status),
										)}
									/>
									{statusLabel(automation.status)}
								</SidebarRow>
								<SidebarRow label="Next run">
									{formatRunTime(automation.nextRunAt)}
								</SidebarRow>
								<SidebarRow label="Last ran">
									{automation.lastRunAt
										? formatRunTime(automation.lastRunAt)
										: "Never"}
								</SidebarRow>
							</SidebarGroup>
							<SidebarGroup title="Details">
								<SidebarRow label="Runs in">
									{automation.runsIn === "chat" ? "Chat" : "Workspace"}
								</SidebarRow>
								{automation.runsIn === "chat" ? (
									<SidebarRow label="Chat">
										<span className="truncate">{sessionName}</span>
									</SidebarRow>
								) : (
									<SidebarRow label="Workspace">
										<span className="truncate">{workspaceName}</span>
									</SidebarRow>
								)}
								<SidebarRow label="Interval">
									<IntervalPicker
										value={automation.schedule}
										align="end"
										onChange={(schedule) =>
											update.mutate({ id: automation.id, schedule })
										}
									/>
								</SidebarRow>
							</SidebarGroup>
						</div>
					</aside>
				</div>
			</div>

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete automation?"
				description={`"${automation.title}" will stop running and be removed. This cannot be undone.`}
				confirmLabel="Delete"
				loading={remove.isPending}
				onConfirm={() =>
					remove.mutate(automation.id, {
						onSuccess: () => {
							setConfirmDelete(false);
							onBack();
						},
					})
				}
			/>
		</div>
	);
}
