// Side-effect hook that mirrors the theme + appearance settings into
// `<html>`'s class list, data attributes, and inline CSS variables, so
// the rest of the app picks up the right tokens without each component
// reaching into settings.
import { useEffect } from "react";
import { invalidateCssColorCache } from "@/lib/css-color";
import {
	type ColorTheme,
	resolveTheme,
	type ThemeMode,
	VALID_COLOR_THEMES,
} from "@/lib/settings";

// Preset class names we need to strip before applying the next one. Source-
// of-truth is VALID_COLOR_THEMES so adding a new preset can't drift;
// "default" has no class so we exclude it.
const COLOR_THEME_CLASSES: readonly ColorTheme[] = VALID_COLOR_THEMES.filter(
	(t) => t !== "default",
);

export type ThemeApplicationOptions = {
	theme: ThemeMode;
	lightTheme: ColorTheme;
	darkTheme: ColorTheme;
	uiFontFamily: string | null;
	codeFontFamily: string | null;
	terminalFontFamily: string | null;
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
		lightTheme,
		darkTheme,
		uiFontFamily,
		codeFontFamily,
		terminalFontFamily,
		chatFontSize,
		usePointerCursors,
	} = opts;

	useEffect(() => {
		const root = document.documentElement;
		const apply = () => {
			const effective = resolveTheme(theme);
			root.classList.toggle("dark", effective === "dark");
			root.style.colorScheme = effective;
			const preset = effective === "dark" ? darkTheme : lightTheme;
			for (const t of COLOR_THEME_CLASSES) {
				if (t !== preset) root.classList.remove(`theme-${t}`);
			}
			if (preset && preset !== "default") {
				root.classList.add(`theme-${preset}`);
			}
			// CSS variables changed — drop cached resolutions.
			invalidateCssColorCache();
			// Monaco's theme is synced via a MutationObserver in
			// `monaco-runtime.ts`; not imported here to stay off the boot
			// path.
		};

		apply();

		if (theme === "system" && typeof window.matchMedia === "function") {
			const mq = window.matchMedia("(prefers-color-scheme: dark)");
			mq.addEventListener("change", apply);
			return () => mq.removeEventListener("change", apply);
		}
	}, [theme, lightTheme, darkTheme]);

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

	useEffect(() => {
		setOrRemoveProperty(
			document.documentElement,
			"--font-terminal-user",
			terminalFontFamily,
		);
	}, [terminalFontFamily]);

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
