import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { WorkspaceRow } from "@/lib/api";
import { workspaceStatusFromGroupId } from "@/lib/workspace-helpers";
import {
	DRAG_MOVE_ACTIVATE_PX,
	DRAG_MOVE_CANCEL_PX,
	ghostCentreY,
	useDndActiveOverlay,
} from "./shared";

// Status grouping: kanban lanes + pinned (drag-to-pin).
function isStatusOrPinnedGroup(groupId: string) {
	return groupId === "pinned" || workspaceStatusFromGroupId(groupId) !== null;
}

const DRAGGABLE_ROW_SELECTOR = "[data-workspace-dnd-row='true']";
const DROP_GROUP_SELECTOR = "[data-workspace-drop-group-id]";

type DragStart = {
	workspaceId: string;
	groupId: string;
	title: string;
	sourceRepoId: string | null;
	clientX: number;
	clientY: number;
	offsetY: number;
	left: number;
	width: number;
	height: number;
	pointerId: number;
};

type DragPointerPosition = {
	clientX: number;
	clientY: number;
	pointerId: number;
};

export type WorkspaceDragState = {
	workspaceId: string;
	title: string;
	sourceGroupId: string;
	sourceRepoId: string | null;
	targetGroupId: string;
	beforeWorkspaceId: string | null;
	clientX: number;
	clientY: number;
	offsetY: number;
	left: number;
	width: number;
	height: number;
};

export type WorkspaceDropTarget = {
	groupId: string;
	beforeWorkspaceId: string | null;
};

export type WorkspaceDndPolicy = {
	canDragRow: (row: WorkspaceRow, sourceGroupId: string) => boolean;
	canDropIntoGroup: (
		sourceGroupId: string,
		targetGroupId: string,
		context: { sourceRepoId: string | null },
	) => boolean;
};

export function isWorkspaceGroupDroppable(groupId: string) {
	return isStatusOrPinnedGroup(groupId);
}

export function useWorkspaceDnd({
	onMoveWorkspace,
	policy,
}: {
	onMoveWorkspace?: (
		workspaceId: string,
		targetGroupId: string,
		beforeWorkspaceId: string | null,
	) => void;
	policy?: WorkspaceDndPolicy;
}) {
	const [dragState, setDragState] = useState<WorkspaceDragState | null>(null);
	const pendingStartRef = useRef<DragStart | null>(null);
	const latestPointerRef = useRef<DragPointerPosition | null>(null);
	const dragFrameRef = useRef<number | null>(null);
	const dragStateRef = useRef<WorkspaceDragState | null>(null);
	dragStateRef.current = dragState;
	useDndActiveOverlay(dragState !== null);

	const clearPendingStart = useCallback(() => {
		pendingStartRef.current = null;
		latestPointerRef.current = null;
		if (dragFrameRef.current !== null) {
			window.cancelAnimationFrame(dragFrameRef.current);
			dragFrameRef.current = null;
		}
	}, []);

	const resolveDropTarget = useCallback(
		(
			_clientX: number,
			clientY: number,
			heightOverride?: number,
			sourceGroupIdOverride?: string,
			workspaceIdOverride?: string,
		): WorkspaceDropTarget | null => {
			const sourceGroupId =
				sourceGroupIdOverride ?? dragStateRef.current?.sourceGroupId;
			const workspaceId =
				workspaceIdOverride ?? dragStateRef.current?.workspaceId;
			if (!sourceGroupId || !workspaceId) return null;

			// Anchor on ghost centre (closestCenter), not pointer. Ghost X
			// stays inside the sidebar even when pointer drifts horizontally.
			const offsetY =
				dragStateRef.current?.offsetY ?? pendingStartRef.current?.offsetY ?? 0;
			const height =
				heightOverride ??
				dragStateRef.current?.height ??
				pendingStartRef.current?.height ??
				0;
			const ghostLeft =
				dragStateRef.current?.left ?? pendingStartRef.current?.left ?? 0;
			const ghostWidth =
				dragStateRef.current?.width ?? pendingStartRef.current?.width ?? 0;
			const ghostCentreX = ghostLeft + ghostWidth / 2;
			const centreY = ghostCentreY({ clientY, offsetY, height });

			// Probe near ghost centre so gaps between groups still hit.
			const probeOffsets = [0, -8, 8, -16, 16, -24, 24];
			let groupElement: HTMLElement | undefined;
			for (const dy of probeOffsets) {
				const elements = document.elementsFromPoint(ghostCentreX, centreY + dy);
				groupElement = elements
					.map((element) => element.closest(DROP_GROUP_SELECTOR))
					.find(Boolean) as HTMLElement | undefined;
				if (groupElement) break;
			}
			const groupId = groupElement?.dataset.workspaceDropGroupId;
			const sourceRepoId =
				dragStateRef.current?.sourceRepoId ??
				pendingStartRef.current?.sourceRepoId ??
				null;
			if (
				!groupId ||
				!(
					policy?.canDropIntoGroup(sourceGroupId, groupId, { sourceRepoId }) ??
					isWorkspaceGroupDroppable(groupId)
				)
			) {
				return null;
			}

			const rowElements = Array.from(
				document.querySelectorAll<HTMLElement>(
					`${DRAGGABLE_ROW_SELECTOR}[data-workspace-dnd-group-id="${CSS.escape(groupId)}"]`,
				),
			).filter((element) => element.dataset.workspaceDndRowId !== workspaceId);

			for (const element of rowElements) {
				const rect = element.getBoundingClientRect();
				if (centreY < rect.top + rect.height / 2) {
					return {
						groupId,
						beforeWorkspaceId: element.dataset.workspaceDndRowId ?? null,
					};
				}
			}

			return { groupId, beforeWorkspaceId: null };
		},
		[policy],
	);

	const beginDrag = useCallback(
		(pending: DragStart, event: PointerEvent) => {
			const target = resolveDropTarget(
				event.clientX,
				event.clientY,
				pending.height,
				pending.groupId,
				pending.workspaceId,
			);
			const next: WorkspaceDragState = {
				workspaceId: pending.workspaceId,
				title: pending.title,
				sourceGroupId: pending.groupId,
				sourceRepoId: pending.sourceRepoId,
				targetGroupId: target?.groupId ?? pending.groupId,
				beforeWorkspaceId: target
					? target.beforeWorkspaceId
					: pending.workspaceId,
				clientX: event.clientX,
				clientY: event.clientY,
				offsetY: pending.offsetY,
				left: pending.left,
				width: pending.width,
				height: pending.height,
			};
			dragStateRef.current = next;
			setDragState(next);
		},
		[resolveDropTarget],
	);

	const flushDragFrame = useCallback(() => {
		dragFrameRef.current = null;
		const active = dragStateRef.current;
		const pointer = latestPointerRef.current;
		if (!active || !pointer) return;
		if (pointer.pointerId !== pendingStartRef.current?.pointerId) return;

		const target = resolveDropTarget(pointer.clientX, pointer.clientY);
		const next: WorkspaceDragState = {
			...active,
			clientX: pointer.clientX,
			clientY: pointer.clientY,
			targetGroupId: target?.groupId ?? active.targetGroupId,
			beforeWorkspaceId: target
				? target.beforeWorkspaceId
				: active.beforeWorkspaceId,
		};
		dragStateRef.current = next;
		setDragState(next);
	}, [resolveDropTarget]);

	const scheduleDragFrame = useCallback(
		(event: PointerEvent) => {
			latestPointerRef.current = {
				clientX: event.clientX,
				clientY: event.clientY,
				pointerId: event.pointerId,
			};
			if (dragFrameRef.current !== null) return;
			dragFrameRef.current = window.requestAnimationFrame(flushDragFrame);
		},
		[flushDragFrame],
	);

	useEffect(() => {
		const handlePointerMove = (event: PointerEvent) => {
			const active = dragStateRef.current;
			if (active) {
				if (event.pointerId !== pendingStartRef.current?.pointerId) {
					return;
				}
				event.preventDefault();
				scheduleDragFrame(event);
				return;
			}

			const pending = pendingStartRef.current;
			if (!pending || event.pointerId !== pending.pointerId) {
				return;
			}

			const dx = event.clientX - pending.clientX;
			const dy = event.clientY - pending.clientY;
			if (Math.abs(dx) > DRAG_MOVE_CANCEL_PX && Math.abs(dx) > Math.abs(dy)) {
				clearPendingStart();
				return;
			}
			if (Math.hypot(dx, dy) >= DRAG_MOVE_ACTIVATE_PX) {
				event.preventDefault();
				beginDrag(pending, event);
			}
		};

		const handlePointerUp = (event: PointerEvent) => {
			if (dragFrameRef.current !== null) {
				window.cancelAnimationFrame(dragFrameRef.current);
				flushDragFrame();
			}
			const active = dragStateRef.current;
			if (active && event.pointerId === pendingStartRef.current?.pointerId) {
				event.preventDefault();
				if (
					active.targetGroupId !== active.sourceGroupId ||
					active.beforeWorkspaceId !== active.workspaceId
				) {
					onMoveWorkspace?.(
						active.workspaceId,
						active.targetGroupId,
						active.beforeWorkspaceId,
					);
				}
				dragStateRef.current = null;
				setDragState(null);
			}
			clearPendingStart();
		};

		window.addEventListener("pointermove", handlePointerMove, {
			passive: false,
		});
		window.addEventListener("pointerup", handlePointerUp, { passive: false });
		window.addEventListener("pointercancel", handlePointerUp, {
			passive: false,
		});
		return () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerUp);
		};
	}, [
		beginDrag,
		clearPendingStart,
		flushDragFrame,
		onMoveWorkspace,
		scheduleDragFrame,
	]);

	const startDragGesture = useCallback(
		({
			event,
			row,
			groupId,
			title,
		}: {
			event: ReactPointerEvent<HTMLElement>;
			row: WorkspaceRow;
			groupId: string;
			title: string;
		}) => {
			if (
				event.button !== 0 ||
				!(
					policy?.canDragRow(row, groupId) ?? isWorkspaceGroupDroppable(groupId)
				) ||
				row.state === "archived"
			) {
				return;
			}

			const target = event.currentTarget;
			const rect = target.getBoundingClientRect();
			clearPendingStart();
			pendingStartRef.current = {
				workspaceId: row.id,
				groupId,
				title,
				sourceRepoId: row.repoId ?? null,
				clientX: event.clientX,
				clientY: event.clientY,
				offsetY: event.clientY - rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
				pointerId: event.pointerId,
			};
		},
		[clearPendingStart, policy],
	);

	const dropTarget = useMemo<WorkspaceDropTarget | null>(() => {
		if (!dragState) return null;
		return {
			groupId: dragState.targetGroupId,
			beforeWorkspaceId: dragState.beforeWorkspaceId,
		};
	}, [dragState]);

	return {
		dragState,
		dropTarget,
		startDragGesture,
	};
}
