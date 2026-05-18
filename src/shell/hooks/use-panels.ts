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

// Module-level resize state store. 故意不放进 React state——订阅它的组件不应该
// 因为拖动开始/结束而重渲染,只在拖动结束时通过 listener 主动 flush 一次。
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

function writeWidthVar(target: ResizeTarget, width: number) {
	if (typeof document === "undefined") return;
	const varName =
		target === "sidebar" ? SIDEBAR_WIDTH_VAR : INSPECTOR_WIDTH_VAR;
	document.documentElement.style.setProperty(varName, `${width}px`);
}

// 模块加载时立刻把初始宽度写到 CSS variable,这样 React 首次 render 前 DOM 就有值,
// 不会出现一帧的 0 宽度闪烁。
if (typeof document !== "undefined") {
	writeWidthVar("sidebar", getInitialSidebarWidth());
	writeWidthVar(
		"inspector",
		getInitialSidebarWidth(INSPECTOR_WIDTH_STORAGE_KEY),
	);
}

export function useShellPanels() {
	const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [inspectorWidth, setInspectorWidth] = useState(() =>
		getInitialSidebarWidth(INSPECTOR_WIDTH_STORAGE_KEY),
	);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);

	// React state -> CSS variable 同步。仅在非拖动场景下生效(键盘步进、初始
	// 载入、mouseup 后的 commit)。拖动期间 CSS variable 由 mousemove 直接写,
	// React state 此时是 stale 的,但 setProperty(同值)是 no-op。
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

		let pendingWidth: number | null = null;
		let rafId: number | null = null;

		// 拖动期间只写 CSS variable, 完全不进 React 渲染路径。
		const flushVar = () => {
			rafId = null;
			if (pendingWidth === null) return;
			writeWidthVar(resizeState.target, pendingWidth);
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
			// 把 CSS variable 最终值 commit 回 React state,
			// 用于持久化 + 触发依赖宽度的非拖动场景(比如设置面板里显示当前宽度)。
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
