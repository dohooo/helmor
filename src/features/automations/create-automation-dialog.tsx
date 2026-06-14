import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import type { AutomationRunsIn, AutomationSchedule } from "@/lib/api";
import { cn } from "@/lib/utils";
import { IntervalPicker } from "./interval-picker";
import { DEFAULT_SCHEDULE } from "./schedule";
import { useAutomationMutations } from "./use-automation-mutations";
import {
	useSessionOptions,
	useWorkspaceOptions,
} from "./use-automation-targets";

/** Compact footer select shared by the mode / workspace / session pickers. */
function TargetSelect({
	label,
	value,
	options,
	onChange,
	disabled = false,
	className,
}: {
	/** Placeholder when nothing is selected yet. */
	label: string;
	value: string | null;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	disabled?: boolean;
	className?: string;
}) {
	const active = options.find((option) => option.value === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled}
					className={cn(
						"max-w-44 justify-between gap-1.5 font-normal",
						className,
					)}
				>
					<span className={cn("truncate", !active && "text-muted-foreground")}>
						{active?.label ?? label}
					</span>
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="max-h-64 w-56 overflow-y-auto"
			>
				{options.length === 0 ? (
					<div className="px-2 py-1.5 text-mini text-muted-foreground">
						Nothing available
					</div>
				) : (
					<DropdownMenuRadioGroup value={value ?? ""} onValueChange={onChange}>
						{options.map((option) => (
							<DropdownMenuRadioItem key={option.value} value={option.value}>
								<span className="truncate">{option.label}</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function CreateAutomationDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [runsIn, setRunsIn] = useState<AutomationRunsIn>("chat");
	const [workspaceId, setWorkspaceId] = useState<string | null>(null);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [schedule, setSchedule] =
		useState<AutomationSchedule>(DEFAULT_SCHEDULE);

	const { create } = useAutomationMutations();
	const workspaces = useWorkspaceOptions(open);
	const sessions = useSessionOptions(
		open && runsIn === "chat" ? workspaceId : null,
	);

	// Fresh form every time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setTitle("");
		setPrompt("");
		setRunsIn("chat");
		setWorkspaceId(null);
		setSessionId(null);
		setSchedule(DEFAULT_SCHEDULE);
	}, [open]);

	const targetValid =
		workspaceId !== null && (runsIn === "workspace" || sessionId !== null);
	const valid = title.trim() !== "" && prompt.trim() !== "" && targetValid;

	const submit = () => {
		if (!valid || !workspaceId || create.isPending) return;
		create.mutate(
			{
				title: title.trim(),
				prompt: prompt.trim(),
				runsIn,
				workspaceId,
				sessionId: runsIn === "chat" ? (sessionId ?? undefined) : undefined,
				schedule,
			},
			{ onSuccess: () => onOpenChange(false) },
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="gap-0 p-0 sm:max-w-[560px]"
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">Create automation</DialogTitle>
				<div className="px-5 pt-5">
					<input
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						placeholder="Automation title"
						aria-label="Automation title"
						className="w-full bg-transparent text-title font-semibold text-foreground outline-none placeholder:text-muted-foreground/60"
					/>
					<Textarea
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="Add prompt e.g. look for crashes in $sentry"
						aria-label="Automation prompt"
						className="mt-2 min-h-28 resize-none border-0 px-0 py-0 text-body shadow-none focus-visible:ring-0 dark:bg-transparent"
					/>
				</div>
				<div className="flex flex-wrap items-center gap-1.5 border-t border-border px-5 py-3">
					<TargetSelect
						label="Target"
						value={runsIn}
						options={[
							{ value: "chat", label: "Chat" },
							{ value: "workspace", label: "Workspace" },
						]}
						onChange={(value) => {
							setRunsIn(value === "workspace" ? "workspace" : "chat");
							setSessionId(null);
						}}
					/>
					<TargetSelect
						label="Select workspace"
						value={workspaceId}
						options={workspaces.map((workspace) => ({
							value: workspace.id,
							label: workspace.title,
						}))}
						onChange={(value) => {
							setWorkspaceId(value);
							setSessionId(null);
						}}
					/>
					{runsIn === "chat" ? (
						<TargetSelect
							label="Select chat"
							value={sessionId}
							disabled={workspaceId === null}
							options={sessions.map((session) => ({
								value: session.id,
								label: session.title,
							}))}
							onChange={setSessionId}
						/>
					) : null}
					<IntervalPicker value={schedule} onChange={setSchedule} />
					<div className="ml-auto flex items-center gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							disabled={!valid || create.isPending}
							onClick={submit}
						>
							Create
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
