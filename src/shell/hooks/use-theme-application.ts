// Side-effect hook that mirrors the theme + dark-theme settings into
// `<html>`'s class list and `colorScheme` so the rest of the app picks up
// the right tokens without each component reaching into settings.
import { useEffect } from "react";
import { type DarkTheme, resolveTheme, type ThemeMode } from "@/lib/settings";

const DARK_THEME_CLASSES: readonly DarkTheme[] = [
	"midnight",
	"forest",
	"ember",
	"aurora",
];

export function useThemeApplication(opts: {
	theme: ThemeMode;
	darkTheme: DarkTheme;
}): void {
	const { theme, darkTheme } = opts;

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
}
