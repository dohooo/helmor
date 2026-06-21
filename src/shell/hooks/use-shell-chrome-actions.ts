import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import { toast } from "sonner";
import { GITHUB_RELEASES_URL } from "@/features/announcements";
import { translateSource } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import { type AppSettings, resolveTheme, type ThemeMode } from "@/lib/settings";
import { publishShellEvent } from "@/shell/event-bus";

/**
 * Chrome-level shell actions AppShell hands to its header / shortcut wiring:
 * theme toggle, zen-mode toggle, model-picker opener, release-changelog
 * opener. Extracted verbatim from AppShell (Phase 2 split).
 *
 * Each handler references only the panel/settings primitives passed in plus
 * module-level helpers, so identities stay stable across unrelated AppShell
 * re-renders. Dependency arrays are preserved exactly as the original inline
 * callbacks.
 */
export function useShellChromeActions({
	theme,
	updateSettings,
	sidebarCollapsed,
	inspectorCollapsed,
	setSidebarCollapsed,
	setInspectorCollapsed,
}: {
	theme: ThemeMode;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
	sidebarCollapsed: boolean;
	inspectorCollapsed: boolean;
	setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
	setInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
}) {
	const handleToggleTheme = useCallback(() => {
		updateSettings({
			theme: resolveTheme(theme) === "dark" ? "light" : "dark",
		});
	}, [theme, updateSettings]);
	const handleToggleZenMode = useCallback(() => {
		const zenActive = sidebarCollapsed && inspectorCollapsed;
		setSidebarCollapsed(!zenActive);
		setInspectorCollapsed(!zenActive);
	}, [inspectorCollapsed, setSidebarCollapsed, sidebarCollapsed]);
	const handleOpenModelPicker = useCallback(() => {
		publishShellEvent({ type: "open-model-picker" });
	}, []);
	const handleOpenReleaseChangelog = useCallback(() => {
		void openUrl(GITHUB_RELEASES_URL).catch((error) => {
			toast.error(translateSource("miscUnableToOpenGithubChangelog"), {
				description: String(error),
			});
		});
	}, []);

	return {
		handleToggleTheme,
		handleToggleZenMode,
		handleOpenModelPicker,
		handleOpenReleaseChangelog,
	};
}
