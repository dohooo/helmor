// IME guards for xterm in WKWebView. Three quirks xterm 6 mishandles:
// 1. An IME's instant commit (e.g. full-width "？") can arrive as keydown +
//    `input` with no keypress; xterm drops insertText while a key is down.
// 2. WebKit can populate the textarea before compositionstart fires, so
//    xterm's composition substring reads empty and the commit never sends.
// 3. Switching input source mid-composition commits the raw pinyin buffer
//    with segmentation spaces ("ni hao") — native terminals get "nihao".
//    Same heuristic as the composer's composition-guard-plugin.

const PURE_PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
/** No data event after a non-empty compositionend within this window →
 * xterm read an empty substring (quirk 2); resend the commit ourselves. */
const COMMIT_FALLBACK_MS = 80;
/** Data this close BEFORE compositionend means xterm already flushed the
 * composition synchronously (e.g. Enter mid-composition) — no fallback. */
const SYNC_FLUSH_MS = 30;

/** Raw pinyin buffer committed by an input-source switch: pure printable
 * ASCII with IME segmentation spaces. Real CJK commits contain non-ASCII. */
export function isAbandonedImeAsciiBuffer(data: string): boolean {
	return (
		PURE_PRINTABLE_ASCII.test(data) && data.includes(" ") && data.trim() !== ""
	);
}

export type TerminalImeGuard = {
	/** Feed every event seen by attachCustomKeyEventHandler. */
	observeKeyEvent: (event: KeyboardEvent) => void;
	/** Add input/compositionend listeners. Call after terminal.open(). */
	attach: (textarea: HTMLTextAreaElement) => void;
	detach: () => void;
	/** Route terminal.onData output through this before forwarding. */
	filterData: (data: string) => string;
};

export function createTerminalImeGuard(
	send: (data: string) => void,
): TerminalImeGuard {
	let textarea: HTMLTextAreaElement | null = null;
	// keyCode 229 → the IME consumed the key; xterm's textarea-diff path owns it.
	let keydownConsumedByIme = false;
	let keypressFired = false;
	let lastDataAt = Number.NEGATIVE_INFINITY;
	let pendingStrip: string | null = null;
	let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

	const cancelFallback = () => {
		if (fallbackTimer !== null) {
			clearTimeout(fallbackTimer);
			fallbackTimer = null;
		}
	};

	// Quirk 1. Inert whenever xterm handled the key: keydown-handled keys
	// preventDefault (no input event at all), keypress-handled chars set
	// keypressFired, IME-consumed keys come as 229, and xterm's own
	// `_inputEvent` preventDefaults what it forwards.
	const handleInput = (event: Event) => {
		const ev = event as InputEvent;
		if (ev.inputType !== "insertText" || !ev.data || ev.isComposing) return;
		if (ev.defaultPrevented || keypressFired || keydownConsumedByIme) return;
		cancelFallback();
		send(ev.data);
	};

	const handleCompositionEnd = (event: Event) => {
		const data = (event as CompositionEvent).data;
		cancelFallback();
		pendingStrip = data && isAbandonedImeAsciiBuffer(data) ? data : null;
		if (!data) return;
		if (performance.now() - lastDataAt < SYNC_FLUSH_MS) return;
		// Quirk 2 fallback — cancelled when xterm delivers the commit itself.
		const payload = pendingStrip ? data.replace(/\s+/g, "") : data;
		fallbackTimer = setTimeout(() => {
			fallbackTimer = null;
			pendingStrip = null;
			send(payload);
		}, COMMIT_FALLBACK_MS);
	};

	return {
		observeKeyEvent(event) {
			if (event.type === "keydown") {
				keydownConsumedByIme = event.keyCode === 229;
				keypressFired = false;
			} else if (event.type === "keypress") {
				keypressFired = true;
			}
		},
		attach(target) {
			textarea = target;
			target.addEventListener("input", handleInput);
			target.addEventListener("compositionend", handleCompositionEnd);
		},
		detach() {
			cancelFallback();
			textarea?.removeEventListener("input", handleInput);
			textarea?.removeEventListener("compositionend", handleCompositionEnd);
			textarea = null;
		},
		filterData(data) {
			// ESC-prefixed traffic (mouse reports, arrows, focus events) is not
			// typed text — it must not consume the pending commit or fallback.
			if (data.startsWith("\x1b")) return data;
			lastDataAt = performance.now();
			cancelFallback();
			const pending = pendingStrip;
			pendingStrip = null;
			// Quirk 3. startsWith: xterm appends chars typed right after the
			// commit to the same data event.
			if (pending !== null && data.startsWith(pending)) {
				return pending.replace(/\s+/g, "") + data.slice(pending.length);
			}
			return data;
		},
	};
}
