import type { Terminal } from "@xterm/xterm";

// ≥50px so consumeWheelEvent's trackpad damping (×0.3 under 50px) can't eat it.
const SYNTHETIC_DELTA_PX = 120;
const FALLBACK_CELL_HEIGHT = 16;
// Safety cap for pathological deltas (momentum flicks, page-mode events).
const MAX_LINES_PER_EVENT = 60;

/**
 * xterm 6 sends at most ONE wheel report (mouse tracking) or arrow key (alt
 * screen) per wheel event and damps small deltas, so TUIs scroll far slower
 * than in iTerm. When the running app consumes scrolling itself, swallow the
 * event and re-dispatch one marked single-line event per line of travel.
 */
export function createTuiWheelHandler(
	terminal: Terminal,
): (ev: WheelEvent) => boolean {
	const synthetic = new WeakSet<WheelEvent>();
	let remainder = 0;

	const cellHeight = () => {
		const screen = terminal.element?.querySelector(".xterm-screen");
		return screen && terminal.rows > 0
			? screen.clientHeight / terminal.rows
			: FALLBACK_CELL_HEIGHT;
	};

	return (ev: WheelEvent): boolean => {
		if (synthetic.has(ev)) return true;
		if (ev.deltaY === 0 || ev.shiftKey) return true;
		const tuiHandlesScroll =
			terminal.modes.mouseTrackingMode !== "none" ||
			terminal.buffer.active.type === "alternate";
		if (!tuiHandlesScroll) return true;

		const fast =
			ev.altKey || ev.ctrlKey
				? (terminal.options.fastScrollSensitivity ?? 5)
				: 1;
		const deltaLines =
			(ev.deltaMode === WheelEvent.DOM_DELTA_LINE
				? ev.deltaY
				: ev.deltaMode === WheelEvent.DOM_DELTA_PAGE
					? ev.deltaY * terminal.rows
					: ev.deltaY / cellHeight()) * fast;
		if (Math.sign(deltaLines) !== Math.sign(remainder)) remainder = 0;
		remainder += deltaLines;
		const lines = Math.trunc(remainder);
		remainder -= lines;

		const count = Math.min(Math.abs(lines), MAX_LINES_PER_EVENT);
		for (let i = 0; i < count; i++) {
			const clone = new WheelEvent("wheel", {
				deltaY: Math.sign(lines) * SYNTHETIC_DELTA_PX,
				deltaMode: WheelEvent.DOM_DELTA_PIXEL,
				clientX: ev.clientX,
				clientY: ev.clientY,
				bubbles: true,
				cancelable: true,
			});
			synthetic.add(clone);
			ev.target?.dispatchEvent(clone);
		}
		ev.preventDefault();
		return false;
	};
}
