import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import {
	clampSidebarWidth,
	getInitialSidebarWidth,
	INSPECTOR_WIDTH_STORAGE_KEY,
	SIDEBAR_RESIZE_STEP,
	SIDEBAR_WIDTH_STORAGE_KEY,
} from "@/shell/layout";

type ResizeTarget = "sidebar" | "inspector";

type ResizeState = {
	pointerX: number;
	sidebarWidth: number;
	target: ResizeTarget;
};

export const SIDEBAR_WIDTH_VAR = "--shell-sidebar-width";
export const INSPECTOR_WIDTH_VAR = "--shell-inspector-width";

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

// Writing custom properties on `documentElement` forces a document-wide style
// invalidation pass on every change. With Monaco's ~2900 cached CSS rules in
// the document after the editor has been opened once, that per-frame work
// blows past the budget on drag (60ms+/frame). Writing the var on the pane +
// separator subtrees instead confines invalidation to those subtrees — combined
// with `contain: layout style` on the pane, the rest of the shell stays cold.
function writeWidthVar(target: ResizeTarget, width: number) {
	if (typeof document === "undefined") return;
	const varName =
		target === "sidebar" ? SIDEBAR_WIDTH_VAR : INSPECTOR_WIDTH_VAR;
	const value = `${width}px`;
	const pane = document.querySelector<HTMLElement>(
		`[data-shell-pane="${target}"]`,
	);
	const separator = document.querySelector<HTMLElement>(
		`[data-shell-resize="${target}"]`,
	);
	pane?.style.setProperty(varName, value);
	separator?.style.setProperty(varName, value);
}

// No module-load seed: each pane / separator falls back to React state via
// `var(--shell-x-width, ${width}px)`, and `useState(getInitialSidebarWidth)`
// initializes state from localStorage before the first render, so the fallback
// already shows the correct width on the first paint.

export function useShellPanels() {
	const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [inspectorWidth, setInspectorWidth] = useState(() =>
		getInitialSidebarWidth(INSPECTOR_WIDTH_STORAGE_KEY),
	);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);

	// React state → CSS var sync. Only fires for non-drag cases (keyboard
	// step, initial mount, mouseup commit). During drag, mousemove writes
	// the var directly and React state is stale — but setProperty with the
	// same value is a no-op.
	useLayoutEffect(() => {
		writeWidthVar("sidebar", sidebarWidth);
	}, [sidebarWidth]);

	useLayoutEffect(() => {
		writeWidthVar("inspector", inspectorWidth);
	}, [inspectorWidth]);

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

	useEffect(() => {
		if (!resizeState) {
			return;
		}

		setResizingActive(true);

		// Cache pane + separator refs once so the 60Hz flush doesn't re-querySelector.
		const targetPane = document.querySelector<HTMLElement>(
			`[data-shell-pane="${resizeState.target}"]`,
		);
		const targetSeparator = document.querySelector<HTMLElement>(
			`[data-shell-resize="${resizeState.target}"]`,
		);
		const varName =
			resizeState.target === "sidebar"
				? SIDEBAR_WIDTH_VAR
				: INSPECTOR_WIDTH_VAR;

		let pendingWidth: number | null = null;
		let rafId: number | null = null;

		// Drag-time path: only writes the CSS var on the pane + separator
		// subtrees, never touches React or documentElement.
		const flushVar = () => {
			rafId = null;
			if (pendingWidth === null) return;
			const value = `${pendingWidth}px`;
			targetPane?.style.setProperty(varName, value);
			targetSeparator?.style.setProperty(varName, value);
		};

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			const deltaX = event.clientX - resizeState.pointerX;
			const rawWidth =
				resizeState.target === "sidebar"
					? resizeState.sidebarWidth + deltaX
					: resizeState.sidebarWidth - deltaX;
			pendingWidth = clampSidebarWidth(rawWidth);
			if (rafId === null) {
				rafId = window.requestAnimationFrame(flushVar);
			}
		};

		const handleMouseUp = () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
				rafId = null;
			}
			flushVar();
			// Commit the final CSS var value back to React state for
			// persistence and any width-dependent non-drag consumers.
			const finalWidth = pendingWidth;
			if (finalWidth !== null) {
				if (resizeState.target === "sidebar") {
					setSidebarWidth(finalWidth);
				} else {
					setInspectorWidth(finalWidth);
				}
			}
			setResizingActive(false);
			setResizeState(null);
		};
		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;

		document.body.style.cursor = "ew-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
			}
			setResizingActive(false);
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [resizeState]);

	const handleResizeStart = useCallback(
		(target: ResizeTarget) => (event: MouseEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			setResizeState({
				pointerX: event.clientX,
				sidebarWidth: target === "sidebar" ? sidebarWidth : inspectorWidth,
				target,
			});
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
		isInspectorResizing: resizeState?.target === "inspector",
		isSidebarResizing: resizeState?.target === "sidebar",
		sidebarCollapsed,
		sidebarWidth,
		setInspectorWidth,
		setSidebarCollapsed,
		setSidebarWidth,
	};
}
