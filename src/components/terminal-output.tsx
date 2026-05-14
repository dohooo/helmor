import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { type ILinkProvider, type ITheme, Terminal } from "@xterm/xterm";
import { memo, useEffect, useRef } from "react";
import { useSettings } from "@/lib/settings";
import "@xterm/xterm/css/xterm.css";

type TerminalOutputProps = {
	terminalRef?: React.RefObject<TerminalHandle | null>;
	className?: string;
	detectLinks?: boolean;
	fontSize?: number;
	fontFamily?: string;
	lineHeight?: number;
	padding?: string;
	/**
	 * Called when the user types (or pastes). The string is the raw bytes
	 * xterm would send over a real PTY — e.g. a literal `\x03` for Ctrl+C,
	 * `\x1b[A` for Up arrow. Forward this to the backend to write into the
	 * PTY master.
	 *
	 * When omitted, xterm still captures keys but they go nowhere.
	 */
	onData?: (data: string) => void;
	/**
	 * Called when the terminal's cell grid changes size (FitAddon resize,
	 * font change, etc). Forward to the backend's `TIOCSWINSZ` so
	 * interactive tools (vim, htop, less) re-layout.
	 */
	onResize?: (cols: number, rows: number) => void;
};

export type TerminalHandle = {
	write: (data: string) => void;
	clear: () => void;
	dispose: () => void;
	/**
	 * Force a FitAddon re-fit. Used when the terminal becomes visible after
	 * being hidden (e.g. outer tab switch) — even though `visibility: hidden`
	 * keeps DOM dimensions intact, xterm's renderer can drop intermediate
	 * frames and benefits from one explicit fit + redraw on re-show.
	 */
	refit: () => void;
	/**
	 * Move keyboard focus into the xterm viewport so the user can start
	 * typing immediately. Used when a terminal tab is activated or when a
	 * new terminal is spawned via `+` / shortcut.
	 */
	focus: () => void;
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.;:!?]+$/;
const DEFAULT_TERMINAL_FONT_FAMILY =
	"'GeistMono', 'SF Mono', Monaco, Menlo, monospace";

function sanitizeHttpUrl(value: string): string | null {
	const trimmed = value.replace(TRAILING_URL_PUNCTUATION, "");
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.toString();
	} catch {
		return null;
	}
}

function openHttpUrl(value: string) {
	const url = sanitizeHttpUrl(value);
	if (!url) return;
	void openUrl(url);
}

function findLineForOffset(
	lineOffsets: readonly number[],
	lineTexts: readonly string[],
	offset: number,
): number | null {
	for (let i = lineOffsets.length - 1; i >= 0; i--) {
		if (offset >= lineOffsets[i]) {
			const lineEnd = lineOffsets[i] + lineTexts[i].length;
			return offset <= lineEnd ? i : null;
		}
	}
	return null;
}

function createHttpLinkProvider(terminal: Terminal): ILinkProvider {
	return {
		provideLinks(bufferLineNumber, callback) {
			const buffer = terminal.buffer.active;
			let startLine = bufferLineNumber - 1;
			while (startLine > 0 && buffer.getLine(startLine)?.isWrapped) {
				startLine--;
			}

			let endLine = bufferLineNumber - 1;
			while (
				endLine + 1 < buffer.length &&
				buffer.getLine(endLine + 1)?.isWrapped
			) {
				endLine++;
			}

			const lineTexts: string[] = [];
			for (let y = startLine; y <= endLine; y++) {
				lineTexts.push(buffer.getLine(y)?.translateToString(false) ?? "");
			}

			const lineOffsets: number[] = [];
			let offset = 0;
			for (const lineText of lineTexts) {
				lineOffsets.push(offset);
				offset += lineText.length;
			}

			const text = lineTexts.join("");
			const links = [...text.matchAll(URL_PATTERN)]
				.map((match) => {
					const rawText = match[0];
					const url = sanitizeHttpUrl(rawText);
					if (!url || match.index === undefined) return null;

					const startOffset = match.index;
					const endOffset =
						startOffset + rawText.replace(TRAILING_URL_PUNCTUATION, "").length;
					const startRelativeLine = findLineForOffset(
						lineOffsets,
						lineTexts,
						startOffset,
					);
					const endRelativeLine = findLineForOffset(
						lineOffsets,
						lineTexts,
						Math.max(startOffset, endOffset - 1),
					);
					if (startRelativeLine === null || endRelativeLine === null) {
						return null;
					}

					return {
						range: {
							start: {
								x: startOffset - lineOffsets[startRelativeLine] + 1,
								y: startLine + startRelativeLine + 1,
							},
							end: {
								x: endOffset - lineOffsets[endRelativeLine] + 1,
								y: startLine + endRelativeLine + 1,
							},
						},
						text: url,
						decorations: {
							pointerCursor: true,
							underline: true,
						},
						activate: (_event: MouseEvent, linkText: string) => {
							openHttpUrl(linkText);
						},
					};
				})
				.filter((link) => link !== null);

			callback(links.length > 0 ? links : undefined);
		},
	};
}

// Global suspend counter — callers wrap heavy animations to skip per-frame
// FitAddon reflows; final fit runs once the last release fires.
let terminalFitSuspendCount = 0;
const terminalRefitListeners = new Set<() => void>();

/** Pause FitAddon.fit() across every mounted TerminalOutput. Idempotent release. */
export function suspendTerminalFit(): () => void {
	terminalFitSuspendCount++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		terminalFitSuspendCount--;
		if (terminalFitSuspendCount === 0) {
			for (const listener of terminalRefitListeners) listener();
		}
	};
}

/** Read --terminal-* and --foreground CSS variables and build an xterm ITheme. */
function resolveTerminalTheme(): ITheme {
	const s = getComputedStyle(document.documentElement);
	const v = (suffix: string) =>
		s.getPropertyValue(`--terminal-${suffix}`).trim();

	// Match the app's global scrollbar colors (foreground @ 18%/30%/40%).
	const fg = s.getPropertyValue("--foreground").trim();
	const mix = (pct: number) =>
		`color-mix(in oklch, ${fg} ${pct}%, transparent)`;

	return {
		background: v("background"),
		foreground: v("foreground"),
		cursor: v("cursor"),
		selectionBackground: v("selection"),
		scrollbarSliderBackground: mix(18),
		scrollbarSliderHoverBackground: mix(30),
		scrollbarSliderActiveBackground: mix(40),
		black: v("black"),
		red: v("red"),
		green: v("green"),
		yellow: v("yellow"),
		blue: v("blue"),
		magenta: v("magenta"),
		cyan: v("cyan"),
		white: v("white"),
		brightBlack: v("bright-black"),
		brightRed: v("bright-red"),
		brightGreen: v("bright-green"),
		brightYellow: v("bright-yellow"),
		brightBlue: v("bright-blue"),
		brightMagenta: v("bright-magenta"),
		brightCyan: v("bright-cyan"),
		brightWhite: v("bright-white"),
	};
}

function resolveTerminalFontFamily(
	fontFamily: string | null | undefined,
): string {
	return fontFamily && fontFamily.length > 0
		? `${fontFamily}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
		: DEFAULT_TERMINAL_FONT_FAMILY;
}

// Memoized so parent re-renders (e.g. inspector width drag) don't push a
// fresh render through the heavy xterm wrapper.
function TerminalOutputImpl({
	terminalRef,
	className,
	detectLinks = false,
	fontSize = 12,
	fontFamily,
	lineHeight = 1.3,
	padding = "12px 2px 12px 12px",
	onData,
	onResize,
}: TerminalOutputProps) {
	const { settings } = useSettings();
	const terminalFontFamily = fontFamily ?? settings.terminalFontFamily;
	const containerRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const runFitRef = useRef<(() => void) | null>(null);
	// Refs so xterm effect doesn't recreate on parent rerender.
	const onDataRef = useRef<typeof onData>(onData);
	const onResizeRef = useRef<typeof onResize>(onResize);
	onDataRef.current = onData;
	onResizeRef.current = onResize;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const fit = new FitAddon();
		const terminal = new Terminal({
			convertEol: true,
			// stdin enabled — forward keystrokes via onData below.
			disableStdin: false,
			scrollback: 5000,
			fontSize,
			fontFamily: resolveTerminalFontFamily(terminalFontFamily),
			lineHeight,
			theme: resolveTerminalTheme(),
			cursorBlink: false,
			cursorStyle: "bar",
			cursorInactiveStyle: "none",
			// Option emits `ESC+<key>` so readline picks up `backward-kill-word`,
			// `backward-word`, `forward-word`. Without it Option produces
			// macOS special chars and shells don't see the binding.
			macOptionIsMeta: true,
			linkHandler: detectLinks
				? {
						activate: (_event, text) => {
							openHttpUrl(text);
						},
					}
				: null,
		});

		terminal.loadAddon(fit);
		terminal.open(container);

		// Translate macOS Cmd combos to readline control codes.
		terminal.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown") return true;
			if (!event.metaKey || event.ctrlKey || event.altKey) return true;

			const key = event.key;
			// Cmd+K — clear screen + scrollback (matches Terminal.app / iTerm).
			if (key.toLowerCase() === "k") {
				terminal.clear();
				return false;
			}
			// Cmd+Backspace — kill the entire input line.
			if (key === "Backspace") {
				onDataRef.current?.("\x15"); // Ctrl+U: unix-line-discard
				return false;
			}
			// Cmd+← — jump cursor to start of line.
			if (key === "ArrowLeft") {
				onDataRef.current?.("\x01"); // Ctrl+A: beginning-of-line
				return false;
			}
			// Cmd+→ — jump cursor to end of line.
			if (key === "ArrowRight") {
				onDataRef.current?.("\x05"); // Ctrl+E: end-of-line
				return false;
			}
			return true;
		});

		const linkProviderDisposable = detectLinks
			? terminal.registerLinkProvider(createHttpLinkProvider(terminal))
			: null;

		// Leading + trailing throttled fit. fit.fit() reflows the 5000-line
		// scrollback every call; without throttle, inspector-width drags
		// fire it per frame and stall the main thread.
		const FIT_THROTTLE_MS = 100;
		let fitTimer: number | null = null;
		let lastFitAt = 0;
		const fitNow = () => {
			lastFitAt = performance.now();
			requestAnimationFrame(() => {
				try {
					fit.fit();
				} catch {
					// Container might be detached.
				}
			});
		};
		const runFit = () => {
			if (fitTimer !== null) {
				window.clearTimeout(fitTimer);
				fitTimer = null;
			}
			const elapsed = performance.now() - lastFitAt;
			if (elapsed >= FIT_THROTTLE_MS) {
				fitNow();
			} else {
				fitTimer = window.setTimeout(() => {
					fitTimer = null;
					fitNow();
				}, FIT_THROTTLE_MS - elapsed);
			}
		};
		runFitRef.current = runFit;

		runFit();

		// Every keystroke / paste flows through here. xterm has already done
		// the key → byte translation (e.g. Ctrl+C → `\x03`), we just
		// forward whatever it produced.
		const dataSub = terminal.onData((data) => {
			onDataRef.current?.(data);
		});

		// xterm fires onResize after FitAddon changes the grid, font size
		// changes, etc. Forward to the backend PTY for TIOCSWINSZ.
		const resizeSub = terminal.onResize(({ cols, rows }) => {
			onResizeRef.current?.(cols, rows);
		});

		const resizeObserver = new ResizeObserver((entries) => {
			// A caller is animating an ancestor — skip the per-frame reflow and
			// rely on `refitListener` below to fit once when the animation ends.
			if (terminalFitSuspendCount > 0) return;
			// Skip while the container is collapsed to 0×0 (e.g. parent in
			// `display: none` state during a tab transition). Calling
			// FitAddon.fit() at zero size truncates xterm's internal buffer
			// dimensions and the next visible frame renders empty until input
			// arrives.
			const entry = entries[0];
			if (
				entry &&
				(entry.contentRect.width === 0 || entry.contentRect.height === 0)
			) {
				return;
			}
			runFit();
		});
		resizeObserver.observe(container);

		// Fired when the last outstanding `suspendTerminalFit()` release runs.
		const refitListener = () => runFit();
		terminalRefitListeners.add(refitListener);

		// Re-resolve CSS variables when app light/dark mode changes.
		const themeObserver = new MutationObserver(() => {
			terminal.options.theme = resolveTerminalTheme();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		xtermRef.current = terminal;
		fitRef.current = fit;

		if (terminalRef) {
			(terminalRef as React.MutableRefObject<TerminalHandle | null>).current = {
				write: (data: string) => terminal.write(data),
				// Scrollback wipe only — `reset()` here would race with replay.
				clear: () => terminal.clear(),
				dispose: () => terminal.dispose(),
				refit: () => runFit(),
				focus: () => terminal.focus(),
			};
		}

		return () => {
			if (fitTimer !== null) {
				window.clearTimeout(fitTimer);
				fitTimer = null;
			}
			dataSub.dispose();
			resizeSub.dispose();
			linkProviderDisposable?.dispose();
			themeObserver.disconnect();
			resizeObserver.disconnect();
			terminalRefitListeners.delete(refitListener);
			terminal.dispose();
			xtermRef.current = null;
			fitRef.current = null;
			runFitRef.current = null;
			if (terminalRef) {
				(terminalRef as React.MutableRefObject<TerminalHandle | null>).current =
					null;
			}
		};
	}, [detectLinks, terminalRef]);

	useEffect(() => {
		const terminal = xtermRef.current;
		if (!terminal) return;
		terminal.options.fontSize = fontSize;
		terminal.options.fontFamily = resolveTerminalFontFamily(terminalFontFamily);
		terminal.options.lineHeight = lineHeight;
		runFitRef.current?.();
		terminal.refresh(0, terminal.rows - 1);
	}, [fontSize, lineHeight, terminalFontFamily]);

	return (
		<div
			className={className}
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				padding,
				backgroundColor: "var(--terminal-background)",
			}}
		>
			<div ref={containerRef} style={{ width: "100%", height: "100%" }} />
		</div>
	);
}

export const TerminalOutput = memo(TerminalOutputImpl);
