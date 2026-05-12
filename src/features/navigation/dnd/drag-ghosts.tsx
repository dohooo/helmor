import type { WorkspaceRow } from "@/lib/api";
import { WorkspaceAvatar } from "../avatar";
import { WorkspaceRowItem } from "../row-item";
import type { RepoDragState } from "./use-repo-dnd";
import type { WorkspaceDragState } from "./use-workspace-dnd";

// Floating preview that follows the pointer during a drag. Two flavours:
//   - WorkspaceDragGhost: single row hovering.
//   - RepoDragGhost: whole repo group (header + rows) hovering as a unit.

type WorkspaceDragGhostProps = {
	dragState: WorkspaceDragState;
	row: WorkspaceRow;
	hideRepoAvatar: boolean;
	selected: boolean;
	isSending?: boolean;
	isInteractionRequired?: boolean;
};

export function WorkspaceDragGhost({
	dragState,
	row,
	hideRepoAvatar,
	selected,
	isSending,
	isInteractionRequired,
}: WorkspaceDragGhostProps) {
	return (
		<div
			className="pointer-events-none fixed z-50"
			style={{
				left: dragState.left,
				right: "auto",
				top: dragState.clientY - dragState.offsetY,
				width: dragState.width,
			}}
		>
			<WorkspaceRowItem
				row={row}
				selected={selected}
				isSending={isSending}
				isInteractionRequired={isInteractionRequired}
				dragPreview
				hideRepoAvatar={hideRepoAvatar}
				workspaceActionsDisabled
			/>
		</div>
	);
}

type RepoDragGhostProps = {
	dragState: RepoDragState;
	rows: WorkspaceRow[];
	repoIconSrc: string | null;
	repoInitials: string | null;
	selectedWorkspaceId?: string | null;
	busyWorkspaceIds?: Set<string>;
	interactionRequiredWorkspaceIds?: Set<string>;
};

export function RepoDragGhost({
	dragState,
	rows,
	repoIconSrc,
	repoInitials,
	selectedWorkspaceId,
	busyWorkspaceIds,
	interactionRequiredWorkspaceIds,
}: RepoDragGhostProps) {
	// Re-use the sidebar's native header + row look; one outer opacity
	// fades the whole stack so it reads as "same group, lifted off".
	return (
		<div
			className="pointer-events-none fixed z-50 opacity-60"
			style={{
				left: dragState.left,
				right: "auto",
				top: dragState.clientY - dragState.offsetY,
				width: dragState.width,
			}}
		>
			<div className="flex w-full select-none items-center gap-2 rounded-lg px-2 py-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground">
				<WorkspaceAvatar
					repoIconSrc={repoIconSrc ?? undefined}
					repoInitials={repoInitials}
					repoName={dragState.label}
					title={dragState.label}
				/>
				<span>{dragState.label}</span>
			</div>
			{rows.map((row) => (
				<div key={row.id} className="pl-2">
					<WorkspaceRowItem
						row={row}
						selected={selectedWorkspaceId === row.id}
						isSending={busyWorkspaceIds?.has(row.id)}
						isInteractionRequired={interactionRequiredWorkspaceIds?.has(row.id)}
						hideRepoAvatar
						workspaceActionsDisabled
					/>
				</div>
			))}
		</div>
	);
}
