import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ILinkProvider, type ITheme, Terminal } from "@xterm/xterm";
import { memo, useEffect, useRef } from "react";
import { resolveCssColor } from "@/lib/css-color";
import { openUrl } from "@/lib/platform-bridge";
import { useSettings } from "@/lib/settings";
import "@xterm/xterm/css/xterm.css";
import { createTerminalImeGuard } from "./terminal-ime";
import {
	clearTerminalWrites,
	disposeTerminalWrites,
	flushTerminalWrites,
	scheduleTerminalWrite,
} from "./terminal-output-scheduler";
import { createTuiWheelHandler } from "./terminal-wheel";

type TerminalOutputProps = {
	terminalRef?: React.RefObject<TerminalHandle | null>;
	className?: string;
	/**
	 * URL detection in terminal output.
	 * - `true`: plain click opens the URL (read-only previews like login
	 *   dialogs, where clicking the link is the primary action).
	 * - `"modifier-click"`: Cmd/Ctrl+click opens the URL — standard terminal
	 *   behavior (Terminal.app, iTerm2, VS Code), so plain clicks still
	 *   select text without accidentally opening the browser.
	 */
	detectLinks?: boolean | "modifier-click";
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
	/**
	 * Whether this terminal is currently visible (active sub-tab + panel open).
	 * Hidden terminals release their WebGL context and coalesce writes in the
	 * background scheduler, so N background terminals don't exhaust the GPU
	 * context budget or starve the foreground one. Defaults to true.
	 */
	isVisible?: boolean;
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
	/**
	 * The cols/rows FitAddon would fit to at the container's current pixel
	 * size, or null while the container is still 0×0 (laid out / hidden).
	 * Lets a caller spawn a PTY at the renderer's real size without waiting
	 * for an `onResize` (which only fires on a size *change*).
	 */
	proposeSize: () => { cols: number; rows: number } | null;
	/**
	 * Re-emit a focus-in (`CSI I`) to a focus-tracking TUI by bouncing the
	 * textarea's DOM focus — but only when it is already the active element,
	 * so this never steals focus. A TUI (e.g. claude) that enabled focus
	 * reporting AFTER our initial `focus()` never saw the event and parks its
	 * cursor at home until the next keystroke; this delivers the missed event.
	 */
	reassertFocus: () => void;
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.;:!?]+$/;
const DEFAULT_TERMINAL_FONT_FAMILY =
	"'Geist Mono Variable', 'SF Mono', Monaco, Menlo, monospace";

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

function shouldActivateLink(event: MouseEvent, requireModifier: boolean) {
	return !requireModifier || event.metaKey || event.ctrlKey;
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

function createHttpLinkProvider(
	terminal: Terminal,
	requireModifier: boolean,
): ILinkProvider {
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
						activate: (event: MouseEvent, linkText: string) => {
							if (shouldActivateLink(event, requireModifier)) {
								openHttpUrl(linkText);
							}
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

// Buffer xterm writes during heavy animations — each chunk's render RAF
// otherwise competes with the drag's RAF.
let terminalWriteSuspendCount = 0;
const terminalWriteFlushListeners = new Set<() => void>();

/** Buffer xterm writes across every mounted TerminalOutput. Idempotent release. */
export function suspendTerminalWrites(): () => void {
	terminalWriteSuspendCount++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		terminalWriteSuspendCount--;
		if (terminalWriteSuspendCount === 0) {
			for (const listener of terminalWriteFlushListeners) listener();
		}
	};
}

function resolveTerminalTheme(): ITheme {
	const v = (suffix: string) => resolveCssColor(`var(--terminal-${suffix})`);
	const mix = (pct: number) =>
		resolveCssColor(
			`color-mix(in oklch, var(--foreground) ${pct}%, transparent)`,
		);

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
	isVisible = true,
}: TerminalOutputProps) {
	const { settings } = useSettings();
	const terminalFontFamily = fontFamily ?? settings.terminalFontFamily;
	const containerRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const runFitRef = useRef<(() => void) | null>(null);
	const webglRef = useRef<WebglAddon | null>(null);
	// Set after a real context loss so we stop trying to rebuild WebGL.
	const webglDisabledRef = useRef(false);
	// Refs so xterm effect doesn't recreate on parent rerender.
	const onDataRef = useRef<typeof onData>(onData);
	const onResizeRef = useRef<typeof onResize>(onResize);
	const isVisibleRef = useRef(isVisible);
	onDataRef.current = onData;
	onResizeRef.current = onResize;
	isVisibleRef.current = isVisible;

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
			// TUIs emit truecolor picked for dark backgrounds; on light themes it
			// reads near-invisible. Nudge low-contrast fg at render time (VS
			// Code's default ratio).
			minimumContrastRatio: 4.5,
			cursorBlink: false,
			cursorStyle: "bar",
			cursorInactiveStyle: "none",
			// Option emits `ESC+<key>` so readline picks up `backward-kill-word`,
			// `backward-word`, `forward-word`. Without it Option produces
			// macOS special chars and shells don't see the binding.
			macOptionIsMeta: true,
			linkHandler: detectLinks
				? {
						activate: (event, text) => {
							if (shouldActivateLink(event, detectLinks === "modifier-click")) {
								openHttpUrl(text);
							}
						},
					}
				: null,
		});

		terminal.loadAddon(fit);
		terminal.open(container);

		// WebGL is attached/detached by the [isVisible] effect below so only
		// visible terminals hold a GPU context — Chromium/WKWebView cap the
		// number of live contexts, and N background terminals would exhaust it.

		// WKWebView IME quirks: dropped full-width commits, lost composition
		// commits, pinyin segmentation spaces. See terminal-ime.ts.
		const ime = createTerminalImeGuard((data) => onDataRef.current?.(data));
		if (terminal.textarea) ime.attach(terminal.textarea);

		// Translate macOS Cmd combos to readline control codes.
		terminal.attachCustomKeyEventHandler((event) => {
			ime.observeKeyEvent(event);
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

		// Restore proportional wheel scrolling inside TUIs (claude/codex).
		terminal.attachCustomWheelEventHandler(createTuiWheelHandler(terminal));

		const linkProviderDisposable = detectLinks
			? terminal.registerLinkProvider(
					createHttpLinkProvider(terminal, detectLinks === "modifier-click"),
				)
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
			onDataRef.current?.(ime.filterData(data));
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

		// Per-instance buffer for writes deferred via `suspendTerminalWrites`.
		// Flushed in one xterm.write so ANSI escapes stay contiguous.
		const suspendedWrites: string[] = [];
		const flushSuspendedWrites = () => {
			if (suspendedWrites.length === 0) return;
			const joined = suspendedWrites.join("");
			suspendedWrites.length = 0;
			scheduleTerminalWrite(terminal, joined, {
				foreground: isVisibleRef.current,
			});
		};
		terminalWriteFlushListeners.add(flushSuspendedWrites);

		// Resync xterm theme on `<html>` class changes; rAF-coalesced.
		let themeScheduled = 0;
		const themeObserver = new MutationObserver(() => {
			if (themeScheduled) return;
			themeScheduled = requestAnimationFrame(() => {
				themeScheduled = 0;
				terminal.options.theme = resolveTerminalTheme();
			});
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		xtermRef.current = terminal;
		fitRef.current = fit;

		if (terminalRef) {
			(terminalRef as React.MutableRefObject<TerminalHandle | null>).current = {
				write: (data: string) => {
					if (terminalWriteSuspendCount > 0) {
						suspendedWrites.push(data);
						return;
					}
					scheduleTerminalWrite(terminal, data, {
						foreground: isVisibleRef.current,
					});
				},
				// Scrollback wipe only — `reset()` here would race with replay.
				clear: () => {
					suspendedWrites.length = 0;
					clearTerminalWrites(terminal);
					terminal.clear();
				},
				dispose: () => terminal.dispose(),
				refit: () => runFit(),
				focus: () => terminal.focus(),
				proposeSize: () => {
					const d = fit.proposeDimensions();
					return d ? { cols: d.cols, rows: d.rows } : null;
				},
				reassertFocus: () => {
					const ta = terminal.textarea;
					if (ta && document.activeElement === ta) {
						ta.blur();
						ta.focus();
					}
				},
			};
		}

		return () => {
			if (fitTimer !== null) {
				window.clearTimeout(fitTimer);
				fitTimer = null;
			}
			if (themeScheduled) {
				cancelAnimationFrame(themeScheduled);
				themeScheduled = 0;
			}
			dataSub.dispose();
			resizeSub.dispose();
			ime.detach();
			linkProviderDisposable?.dispose();
			themeObserver.disconnect();
			resizeObserver.disconnect();
			terminalRefitListeners.delete(refitListener);
			terminalWriteFlushListeners.delete(flushSuspendedWrites);
			disposeTerminalWrites(terminal);
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

	// Attach WebGL only while visible; release the GPU context when hidden so
	// many background terminals don't exhaust the renderer's context budget.
	// On becoming visible, flush output the scheduler coalesced while hidden
	// and re-fit (dimensions may have drifted).
	useEffect(() => {
		const terminal = xtermRef.current;
		if (!terminal || !isVisible) return;
		if (!webglRef.current && !webglDisabledRef.current) {
			try {
				const addon = new WebglAddon();
				addon.onContextLoss(() => {
					addon.dispose();
					webglRef.current = null;
					// A real context loss means the budget is gone — stay on the
					// DOM renderer instead of thrashing attach/loss.
					webglDisabledRef.current = true;
				});
				terminal.loadAddon(addon);
				webglRef.current = addon;
			} catch {
				// WebGL unavailable (headless / very old GPU). DOM renderer stays.
				webglRef.current = null;
			}
		}
		flushTerminalWrites(terminal);
		runFitRef.current?.();
		// A freshly (re)attached WebGL renderer can paint the cursor cell at the
		// stale home position until the next cursor move — force a full redraw so
		// it reflects the buffer's real cursor row after a tab switch back.
		terminal.refresh(0, terminal.rows - 1);
		return () => {
			webglRef.current?.dispose();
			webglRef.current = null;
		};
	}, [isVisible]);

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
