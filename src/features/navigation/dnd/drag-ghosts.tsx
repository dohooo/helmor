import { createPortal } from "react-dom";
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
	/** Tip-first stack chain when dragging a stack tip. When it has >1 member
	 *  the ghost shows a count badge (total PRs in the stack) on the right. */
	stackRows?: WorkspaceRow[] | null;
};

export function WorkspaceDragGhost({
	dragState,
	row,
	hideRepoAvatar,
	selected,
	isSending,
	isInteractionRequired,
	stackRows,
}: WorkspaceDragGhostProps) {
	const stackCount =
		stackRows && stackRows.length > 1 ? stackRows.length : null;
	return createPortal(
		<div
			className="pointer-events-none fixed z-50"
			style={{
				left: dragState.left,
				right: "auto",
				top: dragState.clientY - dragState.offsetY,
				width: dragState.width,
			}}
		>
			<div className="relative">
				<WorkspaceRowItem
					row={row}
					selected={selected}
					isSending={isSending}
					isInteractionRequired={isInteractionRequired}
					dragPreview
					hideRepoAvatar={hideRepoAvatar}
					workspaceActionsDisabled
				/>
				{stackCount ? (
					<span className="absolute right-0 top-1/2 flex h-4 min-w-4 -translate-y-1/2 items-center justify-center rounded-full bg-primary/70 px-1 text-nano font-semibold tabular-nums text-primary-foreground">
						{stackCount}
					</span>
				) : null}
			</div>
		</div>,
		document.body,
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
	return createPortal(
		<div
			className="pointer-events-none fixed z-50 opacity-60"
			style={{
				left: dragState.left,
				right: "auto",
				top: dragState.clientY - dragState.offsetY,
				width: dragState.width,
			}}
		>
			<div className="flex w-full select-none items-center gap-2 rounded-lg px-2 py-1 text-ui font-semibold tracking-[-0.01em] text-foreground">
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
		</div>,
		document.body,
	);
}
