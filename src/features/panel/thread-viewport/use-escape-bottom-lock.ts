// Window-level wheel / arrow / touchmove listeners that release the
// viewport's "stick to bottom" lock as soon as the user scrolls back up.
// Has to be window-level rather than scoped to the scroll parent because
// some inputs (touchmove on iOS, wheel events from inertial scrolling)
// arrive on the document.
import { useEffect } from "react";

export function useEscapeBottomLock({
	scrollParent,
	stopScroll,
	hasUserScrolledRef,
}: {
	scrollParent: HTMLDivElement | null;
	stopScroll: () => void;
	hasUserScrolledRef: React.MutableRefObject<boolean>;
}): void {
	useEffect(() => {
		if (!scrollParent || typeof window === "undefined") return;

		const escapeBottomLock = () => {
			hasUserScrolledRef.current = true;
			stopScroll();
		};
		const inScrollParent = (target: EventTarget | null) =>
			target instanceof Node &&
			(scrollParent === target || scrollParent.contains(target));

		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < -2 && inScrollParent(event.target)) {
				escapeBottomLock();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				(event.key === "ArrowUp" ||
					event.key === "PageUp" ||
					event.key === "Home") &&
				inScrollParent(event.target)
			) {
				escapeBottomLock();
			}
		};
		const onTouchMove = (event: TouchEvent) => {
			if (inScrollParent(event.target)) {
				escapeBottomLock();
			}
		};

		window.addEventListener("wheel", onWheel as EventListener, {
			passive: true,
		});
		window.addEventListener("keydown", onKeyDown as unknown as EventListener, {
			passive: true,
		});
		window.addEventListener(
			"touchmove",
			onTouchMove as unknown as EventListener,
			{ passive: true },
		);
		return () => {
			window.removeEventListener("wheel", onWheel as EventListener);
			window.removeEventListener(
				"keydown",
				onKeyDown as unknown as EventListener,
			);
			window.removeEventListener(
				"touchmove",
				onTouchMove as unknown as EventListener,
			);
		};
	}, [hasUserScrolledRef, scrollParent, stopScroll]);
}
