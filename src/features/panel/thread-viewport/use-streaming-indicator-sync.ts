// DOM-driven sync for the streaming-indicator pseudo row's `top`. We own
// it exclusively from this hook — the indicator JSX deliberately does
// NOT pass `top`, otherwise every React re-render would race with this
// effect and overwrite the synced value with the state-driven one
// (producing the "overlap flashes back in then fixes itself" effect).
//
// When the streaming row's DOM node is mounted we pin the indicator to
// `streaming-row.offsetTop + offsetHeight` via a ResizeObserver. The RO
// callback runs inside the same frame *before* paint, and we only ever
// write a single `style.top`, so this is O(1) regardless of thread
// length. When the streaming row isn't mounted yet we fall back to
// `indicatorFallbackTop` so the indicator doesn't collapse to y=0.
import { useLayoutEffect } from "react";

export function useStreamingIndicatorSync({
	indicatorElRef,
	streamingRowEl,
	indicatorFallbackTop,
}: {
	indicatorElRef: React.MutableRefObject<HTMLDivElement | null>;
	streamingRowEl: HTMLElement | null;
	indicatorFallbackTop: number | undefined;
}): void {
	useLayoutEffect(() => {
		const indicator = indicatorElRef.current;
		if (!indicator) return;

		if (streamingRowEl) {
			const sync = () => {
				indicator.style.top = `${
					streamingRowEl.offsetTop + streamingRowEl.offsetHeight
				}px`;
			};
			sync();
			if (typeof ResizeObserver === "undefined") return;
			const observer = new ResizeObserver(sync);
			observer.observe(streamingRowEl);
			return () => observer.disconnect();
		}

		if (indicatorFallbackTop !== undefined) {
			indicator.style.top = `${indicatorFallbackTop}px`;
		}
	}, [indicatorElRef, streamingRowEl, indicatorFallbackTop]);
}
