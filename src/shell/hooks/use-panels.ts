import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useState,
} from "react";
import {
	clampSidebarWidth,
	getInitialSidebarWidth,
	INSPECTOR_WIDTH_STORAGE_KEY,
	SIDEBAR_RESIZE_HIT_AREA,
	SIDEBAR_RESIZE_STEP,
	SIDEBAR_WIDTH_STORAGE_KEY,
} from "@/shell/layout";

type ResizeTarget = "sidebar" | "inspector";

// Module-level resize state store. Kept out of React state so subscribers
// don't re-render on drag start/end — they only flush via the listener.
type ResizeListener = (active: boolean) => void;
const resizeListeners = new Set<ResizeListener>();
let resizingActive = false;

export function isShellResizing(): boolean {
	return resizingActive;
}

export function onShellResize(listener: ResizeListener): () => void {
	resizeListeners.add(listener);
	return () => {
		resizeListeners.delete(listener);
	};
}

function setResizingActive(active: boolean) {
	if (resizingActive === active) return;
	resizingActive = active;
	for (const listener of resizeListeners) {
		listener(active);
	}
}

// Non-drag inline width writes live in the pane components (they own
// ref + useLayoutEffect so re-mounts always re-write). Drag-time writes
// happen inside `handleResizeStart`. CSS variables are avoided here
// because WebKit invalidates the whole subtree's computed style on every
// `setProperty()`.

export function useShellPanels() {
	const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [inspectorWidth, setInspectorWidth] = useState(() =>
		getInitialSidebarWidth(INSPECTOR_WIDTH_STORAGE_KEY),
	);
	// Drives the `resizing` UI prop on separators; the drag state machine
	// itself lives in the `handleResizeStart` closure.
	const [resizingTarget, setResizingTarget] = useState<ResizeTarget | null>(
		null,
	);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				SIDEBAR_WIDTH_STORAGE_KEY,
				String(sidebarWidth),
			);
		} catch (error) {
			console.error(
				`[helmor] sidebar width save failed for "${SIDEBAR_WIDTH_STORAGE_KEY}"`,
				error,
			);
		}
	}, [sidebarWidth]);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				INSPECTOR_WIDTH_STORAGE_KEY,
				String(inspectorWidth),
			);
		} catch (error) {
			console.error(
				`[helmor] inspector width save failed for "${INSPECTOR_WIDTH_STORAGE_KEY}"`,
				error,
			);
		}
	}, [inspectorWidth]);

	const handleResizeStart = useCallback(
		(target: ResizeTarget) => (event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();

			// Pointer capture routes all subsequent pointer events back here
			// even when the cursor leaves the OS window. Swallow the
			// `NotFoundError` synthetic `PointerEvent`s throw in tests.
			const node = event.currentTarget;
			const pointerId = event.pointerId;
			try {
				node.setPointerCapture(pointerId);
			} catch {}

			const startX = event.clientX;
			const startWidth = target === "sidebar" ? sidebarWidth : inspectorWidth;
			const targetPane = document.querySelector<HTMLElement>(
				`[data-shell-pane="${target}"]`,
			);
			const targetInner = document.querySelector<HTMLElement>(
				`[data-shell-pane-inner="${target}"]`,
			);

			let pendingWidth: number = startWidth;
			let rafId: number | null = null;

			// Drag-time inline writes — bypass React render + CSS-var
			// invalidation to keep per-frame cost in the microsecond range.
			const flushInlineSize = () => {
				rafId = null;
				const widthPx = `${pendingWidth}px`;
				if (targetPane) targetPane.style.width = widthPx;
				if (targetInner) targetInner.style.width = widthPx;
				if (target === "sidebar") {
					node.style.left = `${pendingWidth - SIDEBAR_RESIZE_HIT_AREA / 2}px`;
				} else {
					node.style.right = `${pendingWidth - SIDEBAR_RESIZE_HIT_AREA}px`;
				}
			};

			const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
				if (moveEvent.pointerId !== pointerId) return;
				const deltaX = moveEvent.clientX - startX;
				const rawWidth =
					target === "sidebar" ? startWidth + deltaX : startWidth - deltaX;
				pendingWidth = clampSidebarWidth(rawWidth);
				if (rafId === null) {
					rafId = window.requestAnimationFrame(flushInlineSize);
				}
			};

			const previousCursor = document.body.style.cursor;
			const previousUserSelect = document.body.style.userSelect;
			document.body.style.cursor = "ew-resize";
			document.body.style.userSelect = "none";

			// Full-window overlay absorbs hit-testing so WebKit's `:hover`
			// recompute doesn't cascade through the inspector subtree on
			// every mousemove. Must stay `pointer-events: auto` — pointer
			// capture handles event routing but not hit-test freezing.
			const overlay = document.createElement("div");
			overlay.style.position = "fixed";
			overlay.style.inset = "0";
			overlay.style.zIndex = "2147483647";
			overlay.style.cursor = "ew-resize";
			overlay.setAttribute("data-helmor-resize-overlay", "");
			overlay.setAttribute("aria-hidden", "true");
			document.body.appendChild(overlay);

			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;

				if (rafId !== null) {
					window.cancelAnimationFrame(rafId);
					rafId = null;
				}
				flushInlineSize();

				if (target === "sidebar") {
					setSidebarWidth(pendingWidth);
				} else {
					setInspectorWidth(pendingWidth);
				}

				try {
					node.releasePointerCapture(pointerId);
				} catch {}
				node.removeEventListener("pointermove", handlePointerMove);
				node.removeEventListener("pointerup", finish);
				node.removeEventListener("pointercancel", finish);
				node.removeEventListener("lostpointercapture", finish);

				document.body.style.cursor = previousCursor;
				document.body.style.userSelect = previousUserSelect;
				overlay.remove();

				setResizingTarget(null);
				setResizingActive(false);
			};

			node.addEventListener("pointermove", handlePointerMove);
			node.addEventListener("pointerup", finish);
			// W3C fallbacks for OS-pre-empted gestures / capture lost without
			// a normal pointerup.
			node.addEventListener("pointercancel", finish);
			node.addEventListener("lostpointercapture", finish);

			setResizingTarget(target);
			setResizingActive(true);
		},
		[sidebarWidth, inspectorWidth],
	);

	const handleResizeKeyDown = useCallback(
		(target: ResizeTarget) => (event: KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				if (target === "sidebar") {
					setSidebarWidth((currentWidth) =>
						clampSidebarWidth(currentWidth - SIDEBAR_RESIZE_STEP),
					);
					return;
				}

				setInspectorWidth((currentWidth) =>
					clampSidebarWidth(currentWidth + SIDEBAR_RESIZE_STEP),
				);
			}

			if (event.key === "ArrowRight") {
				event.preventDefault();
				if (target === "sidebar") {
					setSidebarWidth((currentWidth) =>
						clampSidebarWidth(currentWidth + SIDEBAR_RESIZE_STEP),
					);
					return;
				}

				setInspectorWidth((currentWidth) =>
					clampSidebarWidth(currentWidth - SIDEBAR_RESIZE_STEP),
				);
			}
		},
		[],
	);

	return {
		handleResizeKeyDown,
		handleResizeStart,
		inspectorWidth,
		isInspectorResizing: resizingTarget === "inspector",
		isSidebarResizing: resizingTarget === "sidebar",
		sidebarCollapsed,
		sidebarWidth,
		setInspectorWidth,
		setSidebarCollapsed,
		setSidebarWidth,
	};
}
