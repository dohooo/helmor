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

const MOVE_CANCEL_PX = 10;
const MOVE_ACTIVATE_PX = 3;
const DRAGGABLE_ROW_SELECTOR = "[data-workspace-dnd-row='true']";
const DROP_GROUP_SELECTOR = "[data-workspace-drop-group-id]";
export const WORKSPACE_DND_ACTIVE_ATTRIBUTE = "data-workspace-dnd-active";
export const WORKSPACE_DND_ACTIVE_CHANGE_EVENT = "workspace-dnd-active-change";
const DRAG_CURSOR_STYLE_ID = "workspace-dnd-cursor-style";

type DragStart = {
	workspaceId: string;
	groupId: string;
	title: string;
	clientX: number;
	clientY: number;
	offsetY: number;
	left: number;
	width: number;
	pointerId: number;
};

export type WorkspaceDragState = {
	workspaceId: string;
	title: string;
	sourceGroupId: string;
	targetGroupId: string;
	beforeWorkspaceId: string | null;
	clientX: number;
	clientY: number;
	offsetY: number;
	left: number;
	width: number;
};

export type WorkspaceDropTarget = {
	groupId: string;
	beforeWorkspaceId: string | null;
};

export type WorkspaceDndPolicy = {
	canDragRow: (row: WorkspaceRow, sourceGroupId: string) => boolean;
	canDropIntoGroup: (sourceGroupId: string, targetGroupId: string) => boolean;
};

export function isWorkspaceGroupDroppable(groupId: string) {
	return workspaceStatusFromGroupId(groupId) !== null;
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
	const dragStateRef = useRef<WorkspaceDragState | null>(null);
	dragStateRef.current = dragState;
	const isDragging = dragState !== null;

	useEffect(() => {
		if (!isDragging) return;

		const root = document.documentElement;
		let styleElement = document.getElementById(DRAG_CURSOR_STYLE_ID);
		if (!styleElement) {
			styleElement = document.createElement("style");
			styleElement.id = DRAG_CURSOR_STYLE_ID;
			styleElement.textContent = `
				[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"],
				[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] * {
					cursor: grabbing !important;
				}
				[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] [data-workspace-row-body]:hover {
					background-color: transparent !important;
				}
				[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] .workspace-row-selected[data-workspace-row-body]:hover {
					background: var(--workspace-sidebar-selected-bg) !important;
				}
				[${WORKSPACE_DND_ACTIVE_ATTRIBUTE}="true"] [data-workspace-row-actions] {
					opacity: 0 !important;
					pointer-events: none !important;
				}
			`;
			document.head.appendChild(styleElement);
		}
		root.setAttribute(WORKSPACE_DND_ACTIVE_ATTRIBUTE, "true");
		window.dispatchEvent(new Event(WORKSPACE_DND_ACTIVE_CHANGE_EVENT));

		return () => {
			root.removeAttribute(WORKSPACE_DND_ACTIVE_ATTRIBUTE);
			window.dispatchEvent(new Event(WORKSPACE_DND_ACTIVE_CHANGE_EVENT));
		};
	}, [isDragging]);

	const clearPendingStart = useCallback(() => {
		pendingStartRef.current = null;
	}, []);

	const beginDrag = useCallback((pending: DragStart, event: PointerEvent) => {
		setDragState({
			workspaceId: pending.workspaceId,
			title: pending.title,
			sourceGroupId: pending.groupId,
			targetGroupId: pending.groupId,
			beforeWorkspaceId: pending.workspaceId,
			clientX: event.clientX,
			clientY: event.clientY,
			offsetY: pending.offsetY,
			left: pending.left,
			width: pending.width,
		});
	}, []);

	const resolveDropTarget = useCallback(
		(clientX: number, clientY: number): WorkspaceDropTarget | null => {
			const elements = document.elementsFromPoint(clientX, clientY);
			const groupElement = elements
				.map((element) => element.closest(DROP_GROUP_SELECTOR))
				.find(Boolean) as HTMLElement | undefined;
			const groupId = groupElement?.dataset.workspaceDropGroupId;
			const sourceGroupId = dragStateRef.current?.sourceGroupId;
			if (
				!groupId ||
				!sourceGroupId ||
				!(
					policy?.canDropIntoGroup(sourceGroupId, groupId) ??
					isWorkspaceGroupDroppable(groupId)
				)
			) {
				return null;
			}

			const rowElements = Array.from(
				document.querySelectorAll<HTMLElement>(
					`${DRAGGABLE_ROW_SELECTOR}[data-workspace-dnd-group-id="${CSS.escape(groupId)}"]`,
				),
			).filter(
				(element) =>
					element.dataset.workspaceDndRowId !==
					dragStateRef.current?.workspaceId,
			);

			for (const element of rowElements) {
				const rect = element.getBoundingClientRect();
				if (clientY < rect.top + rect.height / 2) {
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

	useEffect(() => {
		const handlePointerMove = (event: PointerEvent) => {
			const active = dragStateRef.current;
			if (active) {
				if (event.pointerId !== pendingStartRef.current?.pointerId) {
					return;
				}
				event.preventDefault();
				const target = resolveDropTarget(event.clientX, event.clientY);
				setDragState((current) =>
					current
						? {
								...current,
								clientX: event.clientX,
								clientY: event.clientY,
								targetGroupId: target?.groupId ?? current.targetGroupId,
								beforeWorkspaceId: target
									? target.beforeWorkspaceId
									: current.beforeWorkspaceId,
							}
						: current,
				);
				return;
			}

			const pending = pendingStartRef.current;
			if (!pending || event.pointerId !== pending.pointerId) {
				return;
			}

			const dx = event.clientX - pending.clientX;
			const dy = event.clientY - pending.clientY;
			if (Math.abs(dx) > MOVE_CANCEL_PX && Math.abs(dx) > Math.abs(dy)) {
				clearPendingStart();
				return;
			}
			if (Math.hypot(dx, dy) >= MOVE_ACTIVATE_PX) {
				event.preventDefault();
				beginDrag(pending, event);
			}
		};

		const handlePointerUp = (event: PointerEvent) => {
			const active = dragStateRef.current;
			if (active && event.pointerId === pendingStartRef.current?.pointerId) {
				event.preventDefault();
				let moved = false;
				if (
					active.targetGroupId !== active.sourceGroupId ||
					active.beforeWorkspaceId !== active.workspaceId
				) {
					onMoveWorkspace?.(
						active.workspaceId,
						active.targetGroupId,
						active.beforeWorkspaceId,
					);
					moved = true;
				}
				if (moved) {
					window.requestAnimationFrame(() => setDragState(null));
				} else {
					setDragState(null);
				}
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
	}, [beginDrag, clearPendingStart, onMoveWorkspace, resolveDropTarget]);

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
				row.pinnedAt ||
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
				clientX: event.clientX,
				clientY: event.clientY,
				offsetY: event.clientY - rect.top,
				left: rect.left,
				width: rect.width,
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
