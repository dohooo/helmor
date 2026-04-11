import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

type TerminalOutputProps = {
	terminalRef?: React.RefObject<TerminalHandle | null>;
	className?: string;
};

export type TerminalHandle = {
	write: (data: string) => void;
	clear: () => void;
	dispose: () => void;
};

const DARK_THEME: ITheme = {
	background: "oklch(0.205 0 0)",
	foreground: "oklch(0.87 0 0)",
	cursor: "oklch(0.87 0 0)",
	selectionBackground: "oklch(0.4 0.02 264)",
	black: "#1e1e2e",
	red: "#f38ba8",
	green: "#a6e3a1",
	yellow: "#f9e2af",
	blue: "#89b4fa",
	magenta: "#cba6f7",
	cyan: "#94e2d5",
	white: "#cdd6f4",
	brightBlack: "#585b70",
	brightRed: "#f38ba8",
	brightGreen: "#a6e3a1",
	brightYellow: "#f9e2af",
	brightBlue: "#89b4fa",
	brightMagenta: "#cba6f7",
	brightCyan: "#94e2d5",
	brightWhite: "#a6adc8",
};

const LIGHT_THEME: ITheme = {
	background: "oklch(0.985 0 0)",
	foreground: "oklch(0.205 0 0)",
	cursor: "oklch(0.205 0 0)",
	selectionBackground: "oklch(0.85 0.02 264)",
	black: "#5c6370",
	red: "#e45649",
	green: "#50a14f",
	yellow: "#c18401",
	blue: "#4078f2",
	magenta: "#a626a4",
	cyan: "#0184bc",
	white: "#fafafa",
	brightBlack: "#4f525e",
	brightRed: "#e06c75",
	brightGreen: "#98c379",
	brightYellow: "#e5c07b",
	brightBlue: "#61afef",
	brightMagenta: "#c678dd",
	brightCyan: "#56b6c2",
	brightWhite: "#ffffff",
};

function isDark() {
	return document.documentElement.classList.contains("dark");
}

export function TerminalOutput({
	terminalRef,
	className,
}: TerminalOutputProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const fit = new FitAddon();
		const terminal = new Terminal({
			convertEol: true,
			disableStdin: true,
			scrollback: 5000,
			fontSize: 12,
			fontFamily: "'GeistMono', 'SF Mono', Monaco, Menlo, monospace",
			lineHeight: 1.3,
			theme: isDark() ? DARK_THEME : LIGHT_THEME,
			cursorBlink: false,
			cursorStyle: "bar",
			cursorInactiveStyle: "none",
		});

		terminal.loadAddon(fit);
		terminal.open(container);

		requestAnimationFrame(() => fit.fit());

		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				try {
					fit.fit();
				} catch {
					// Container might be detached.
				}
			});
		});
		resizeObserver.observe(container);

		// Sync xterm theme when app light/dark mode changes.
		const themeObserver = new MutationObserver(() => {
			terminal.options.theme = isDark() ? DARK_THEME : LIGHT_THEME;
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
				clear: () => {
					terminal.clear();
					terminal.reset();
				},
				dispose: () => terminal.dispose(),
			};
		}

		return () => {
			themeObserver.disconnect();
			resizeObserver.disconnect();
			terminal.dispose();
			xtermRef.current = null;
			fitRef.current = null;
			if (terminalRef) {
				(terminalRef as React.MutableRefObject<TerminalHandle | null>).current =
					null;
			}
		};
	}, [terminalRef]);

	return (
		<div
			ref={containerRef}
			className={className}
			style={{ width: "100%", height: "100%" }}
		/>
	);
}
