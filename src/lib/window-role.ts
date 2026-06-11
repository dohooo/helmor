import { getCurrentWindow } from "@tauri-apps/api/window";

export const QUICK_PANEL_WINDOW_LABEL = "quick";

function resolveWindowLabel(): string {
	try {
		// jsdom test mocks return a window object without `label`; treat any
		// non-quick (including missing) label as the main window.
		return getCurrentWindow().label ?? "main";
	} catch {
		return "main";
	}
}

/**
 * Which Tauri window this webview is running in. Resolved once at module load —
 * a webview can never migrate between windows.
 *
 * `isQuickPanelWindow` gates the per-app singleton concerns that must run in
 * exactly one window (updater, dock badge, settings-persisted navigation,
 * OS-hotkey sync) so the quick panel can mount the same shell stack without
 * double-driving them.
 */
export const windowLabel: string = resolveWindowLabel();
export const isQuickPanelWindow: boolean =
	windowLabel === QUICK_PANEL_WINDOW_LABEL;
