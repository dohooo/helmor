import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	DRAG_MOVE_ACTIVATE_PX,
	DRAG_MOVE_CANCEL_PX,
	ghostCentreY,
	useDndActiveOverlay,
} from "./shared";

// Repo-bucket drag — single axis, reorders top-level repo groups.
const REPO_HANDLE_SELECTOR = "[data-repo-dnd-handle='true']";

type RepoDragStart = {
	repoId: string;
	label: string;
	clientX: number;
	clientY: number;
	offsetY: number;
	left: number;
	width: number;
	/** Full group height (header + rows). */
	/** Full header height — sets the ghost-centre hit-test anchor. */
	height: number;
	pointerId: number;
};

type RepoPointerPosition = {
	clientX: number;
	clientY: number;
	pointerId: number;
};

export type RepoDragState = {
	repoId: string;
	label: string;
	beforeRepoId: string | null;
	clientX: number;
	clientY: number;
	offsetY: number;
	left: number;
	width: number;
	height: number;
};

export function useRepoDnd({
	onMoveRepo,
}: {
	onMoveRepo?: (repoId: string, beforeRepoId: string | null) => void;
}) {
	const [dragState, setDragState] = useState<RepoDragState | null>(null);
	const pendingStartRef = useRef<RepoDragStart | null>(null);
	const latestPointerRef = useRef<RepoPointerPosition | null>(null);
	const dragFrameRef = useRef<number | null>(null);
	const dragStateRef = useRef<RepoDragState | null>(null);
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

	const resolveBeforeRepoId = useCallback(
		(
			clientY: number,
			movingRepoId: string,
			heightOverride?: number,
		): string | null => {
			// Anchor on ghost centre, not pointer.
			const offsetY =
				dragStateRef.current?.offsetY ?? pendingStartRef.current?.offsetY ?? 0;
			const height =
				heightOverride ??
				dragStateRef.current?.height ??
				pendingStartRef.current?.height ??
				0;
			const centreY = ghostCentreY({ clientY, offsetY, height });
			const handles = Array.from(
				document.querySelectorAll<HTMLElement>(REPO_HANDLE_SELECTOR),
			).filter((el) => el.dataset.repoDndId !== movingRepoId);
			for (const handle of handles) {
				const rect = handle.getBoundingClientRect();
				if (centreY < rect.top + rect.height / 2) {
					return handle.dataset.repoDndId ?? null;
				}
			}
			return null;
		},
		[],
	);

	const beginDrag = useCallback(
		(pending: RepoDragStart, event: PointerEvent) => {
			const beforeRepoId = resolveBeforeRepoId(
				event.clientY,
				pending.repoId,
				pending.height,
			);
			const next: RepoDragState = {
				repoId: pending.repoId,
				label: pending.label,
				beforeRepoId,
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
		[resolveBeforeRepoId],
	);

	const flushDragFrame = useCallback(() => {
		dragFrameRef.current = null;
		const active = dragStateRef.current;
		const pointer = latestPointerRef.current;
		if (!active || !pointer) return;
		if (pointer.pointerId !== pendingStartRef.current?.pointerId) return;
		const beforeRepoId = resolveBeforeRepoId(pointer.clientY, active.repoId);
		const next: RepoDragState = {
			...active,
			clientX: pointer.clientX,
			clientY: pointer.clientY,
			beforeRepoId,
		};
		dragStateRef.current = next;
		setDragState(next);
	}, [resolveBeforeRepoId]);

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
				if (event.pointerId !== pendingStartRef.current?.pointerId) return;
				event.preventDefault();
				scheduleDragFrame(event);
				return;
			}
			const pending = pendingStartRef.current;
			if (!pending || event.pointerId !== pending.pointerId) return;
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
				if (active.beforeRepoId !== active.repoId) {
					onMoveRepo?.(active.repoId, active.beforeRepoId);
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
		onMoveRepo,
		scheduleDragFrame,
	]);

	const startRepoDragGesture = useCallback(
		({
			event,
			repoId,
			label,
		}: {
			event: ReactPointerEvent<HTMLElement>;
			repoId: string;
			label: string;
		}) => {
			if (event.button !== 0) return;
			const target = event.currentTarget;
			const rect = target.getBoundingClientRect();
			clearPendingStart();
			pendingStartRef.current = {
				repoId,
				label,
				clientX: event.clientX,
				clientY: event.clientY,
				offsetY: event.clientY - rect.top,
				left: rect.left,
				width: rect.width,
				// Hit-test on header alone — ghost visually carries the rows,
				// but anchoring on the full stack feels shifted way down.
				height: rect.height,
				pointerId: event.pointerId,
			};
		},
		[clearPendingStart],
	);

	const dropIndicator = useMemo<{
		beforeRepoId: string | null;
	} | null>(() => {
		if (!dragState) return null;
		return { beforeRepoId: dragState.beforeRepoId };
	}, [dragState]);

	return {
		dragState,
		dropIndicator,
		startRepoDragGesture,
	};
}
