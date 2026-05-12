// Side-effect hook that mirrors the theme + appearance settings into
// `<html>`'s class list, data attributes, and inline CSS variables, so
// the rest of the app picks up the right tokens without each component
// reaching into settings.
import { useEffect } from "react";
import { type DarkTheme, resolveTheme, type ThemeMode } from "@/lib/settings";

const DARK_THEME_CLASSES: readonly DarkTheme[] = [
	"midnight",
	"forest",
	"ember",
	"aurora",
];

export type ThemeApplicationOptions = {
	theme: ThemeMode;
	darkTheme: DarkTheme;
	uiFontFamily: string | null;
	codeFontFamily: string | null;
	chatFontSize: number;
	usePointerCursors: boolean;
};

function setOrRemoveProperty(
	root: HTMLElement,
	property: string,
	value: string | null,
): void {
	if (value && value.length > 0) {
		root.style.setProperty(property, value);
	} else {
		root.style.removeProperty(property);
	}
}

export function useThemeApplication(opts: ThemeApplicationOptions): void {
	const {
		theme,
		darkTheme,
		uiFontFamily,
		codeFontFamily,
		chatFontSize,
		usePointerCursors,
	} = opts;

	useEffect(() => {
		const apply = () => {
			const effective = resolveTheme(theme);
			document.documentElement.classList.toggle("dark", effective === "dark");
			document.documentElement.style.colorScheme = effective;
			// Monaco's theme is synced via a MutationObserver inside
			// `monaco-runtime.ts` — avoid importing it here to keep Monaco out
			// of the critical boot path and out of tests that never open the
			// editor.
		};

		apply();

		if (theme === "system" && typeof window.matchMedia === "function") {
			const mq = window.matchMedia("(prefers-color-scheme: dark)");
			mq.addEventListener("change", apply);
			return () => mq.removeEventListener("change", apply);
		}
	}, [theme]);

	useEffect(() => {
		for (const t of DARK_THEME_CLASSES) {
			document.documentElement.classList.remove(`theme-${t}`);
		}
		if (darkTheme && darkTheme !== "default") {
			document.documentElement.classList.add(`theme-${darkTheme}`);
		}
	}, [darkTheme]);

	// Font family overrides. `--font-sans` / `--font-mono` are also written by
	// Tailwind's @theme block in `App.css`, but inline style on :root wins.
	useEffect(() => {
		setOrRemoveProperty(
			document.documentElement,
			"--font-sans-user",
			uiFontFamily,
		);
	}, [uiFontFamily]);

	useEffect(() => {
		setOrRemoveProperty(
			document.documentElement,
			"--font-mono-user",
			codeFontFamily,
		);
	}, [codeFontFamily]);

	// Chat font size mirrored to a CSS var so message components can pick
	// it up without prop drilling. (They currently inline-style it from
	// settings; the var is here for future css-only consumers.)
	useEffect(() => {
		document.documentElement.style.setProperty(
			"--chat-font-size",
			`${chatFontSize}px`,
		);
	}, [chatFontSize]);

	// Pointer-cursor toggle — class on <html> so CSS can flip the global
	// cursor rule without a JS round-trip.
	useEffect(() => {
		document.documentElement.classList.toggle(
			"no-pointer-cursors",
			!usePointerCursors,
		);
	}, [usePointerCursors]);
}
