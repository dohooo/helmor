import { ArrowRight, ChevronDown, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HyperText } from "@/components/ui/hyper-text";
import { cn } from "@/lib/utils";
import { branchToneClasses, type WorkspaceBranchTone } from "./shared";

/**
 * Pure-UI strip rendering the workspace branch indicator + arrow + target
 * branch + agent picker on the right.
 *
 * Mirrors the top row of the real `WorkspacePanelHeader`. Used directly by the
 * onboarding mockup and is also a useful reference for the real header
 * (which still owns the BranchPicker / branch rename machinery inline).
 */
export type ConversationHeaderUIProps = {
	branch: string | null;
	branchTone: WorkspaceBranchTone;
	targetBranch?: { remote: string; branch: string } | null;
	/** Right-aligned content — typically the agent picker. */
	rightSlot?: ReactNode;
	/** Optional leading content before the branch (e.g. spacer for traffic lights). */
	leadingSlot?: ReactNode;
};

export function ConversationHeaderUI({
	branch,
	branchTone,
	targetBranch,
	rightSlot,
	leadingSlot,
}: ConversationHeaderUIProps) {
	return (
		<div
			aria-label="Workspace header"
			className="flex h-9 items-center justify-between gap-3 px-[18px]"
			data-tauri-drag-region
		>
			<div className="relative z-0 flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-[12.5px]">
				{leadingSlot}
				<span className="group/branch relative inline-flex items-center gap-1 overflow-hidden px-1 py-0.5 font-medium text-foreground">
					<GitBranch
						className={cn("size-3.5 shrink-0", branchToneClasses[branchTone])}
						strokeWidth={1.9}
					/>
					<HyperText text={branch ?? "No branch"} className="truncate" />
				</span>
				{targetBranch ? (
					<>
						<ArrowRight
							className="relative top-px size-3 shrink-0 self-center text-muted-foreground"
							strokeWidth={1.8}
						/>
						<span className="inline-flex items-center gap-1 px-1 py-0.5 font-medium text-muted-foreground">
							{targetBranch.remote}/{targetBranch.branch}
							<ChevronDown className="size-3 opacity-50" />
						</span>
					</>
				) : null}
			</div>
			{rightSlot ? (
				<div className="relative z-10 flex shrink-0 items-center gap-1 bg-background pl-1">
					{rightSlot}
				</div>
			) : null}
		</div>
	);
}

/**
 * The agent picker affordance — usually a provider icon + label + chevron.
 * Composed into `rightSlot` of `ConversationHeaderUI`.
 */
export function AgentPickerButtonUI({
	icon,
	label,
}: {
	icon: ReactNode;
	label: string;
}) {
	return (
		<Button
			variant="ghost"
			size="xs"
			className="h-6 gap-1 text-muted-foreground"
		>
			{icon}
			<span>{label}</span>
			<ChevronDown className="size-3 opacity-50" />
		</Button>
	);
}
