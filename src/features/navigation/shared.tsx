import {
	IssueClosedIcon,
	IssueDraftIcon,
	XCircleFillIcon,
} from "@primer/octicons-react";
import { Pin } from "lucide-react";
import type { GroupTone, WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { WorkspaceBranchTone } from "@/lib/workspace-helpers";

export const groupToneClasses: Record<GroupTone, string> = {
	pinned: "text-[var(--workspace-sidebar-status-neutral)]",
	done: "text-[var(--workspace-sidebar-status-done)]",
	review: "text-[var(--workspace-sidebar-status-review)]",
	progress: "text-[var(--workspace-sidebar-status-progress)]",
	backlog: "text-[var(--workspace-sidebar-status-backlog)]",
	canceled: "text-[var(--workspace-sidebar-status-canceled)]",
};

export const branchToneClasses: Record<WorkspaceBranchTone, string> = {
	working: "text-[var(--workspace-branch-status-working)]",
	open: "text-[var(--workspace-branch-status-open)]",
	merged: "text-[var(--workspace-branch-status-merged)]",
	closed: "text-[var(--workspace-branch-status-closed)]",
	inactive: "text-[var(--workspace-branch-status-inactive)]",
};

export const ARCHIVED_SECTION_ID = "__archived__";
export const STATUS_OPTIONS: ReadonlyArray<{
	value: string;
	label: string;
	tone: GroupTone;
}> = [
	{ value: "backlog", label: "Backlog", tone: "backlog" },
	{ value: "in-progress", label: "In progress", tone: "progress" },
	{ value: "review", label: "In review", tone: "review" },
	{ value: "done", label: "Done", tone: "done" },
	{ value: "canceled", label: "Canceled", tone: "canceled" },
];

export function humanizeBranch(branch: string): string {
	const slug = branch.includes("/")
		? branch.slice(branch.indexOf("/") + 1)
		: branch;
	return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function PartialCircleIcon({
	tone,
	inset,
	variant,
}: {
	tone: Extract<GroupTone, "review" | "progress">;
	inset: number;
	variant: "half-right" | "three-quarters";
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative block size-[14px] shrink-0 rounded-full border border-current",
				groupToneClasses[tone],
			)}
		>
			{variant === "half-right" ? (
				<span
					className="absolute rounded-r-full bg-current"
					style={{
						top: `${inset}px`,
						right: `${inset}px`,
						bottom: `${inset}px`,
						width: "4px",
					}}
				/>
			) : (
				<span
					className="absolute rounded-full bg-current"
					style={{
						inset: `${inset}px`,
						clipPath:
							"polygon(50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 50%, 50% 50%)",
					}}
				/>
			)}
		</span>
	);
}

export function GroupIcon({ tone }: { tone: GroupTone }) {
	const className = cn("shrink-0", groupToneClasses[tone]);
	const iconSize = 14;

	switch (tone) {
		case "pinned":
			return (
				<Pin
					className={cn(className, "-rotate-45")}
					size={iconSize}
					strokeWidth={2}
				/>
			);
		case "done":
			return <IssueClosedIcon className={className} size={iconSize} />;
		case "review":
			return (
				<PartialCircleIcon
					tone="review"
					inset={2.25}
					variant="three-quarters"
				/>
			);
		case "progress":
			return (
				<PartialCircleIcon tone="progress" inset={2.5} variant="half-right" />
			);
		case "backlog":
			return <IssueDraftIcon className={className} size={iconSize} />;
		case "canceled":
			return <XCircleFillIcon className={className} size={iconSize} />;
	}
}

export function findSelectedSectionId(
	selectedWorkspaceId: string | null | undefined,
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
) {
	if (!selectedWorkspaceId) {
		return null;
	}

	for (const group of groups) {
		if (group.rows.some((row) => row.id === selectedWorkspaceId)) {
			return group.id;
		}
	}

	if (archivedRows.some((row) => row.id === selectedWorkspaceId)) {
		return ARCHIVED_SECTION_ID;
	}

	return null;
}
