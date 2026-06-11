/**
 * Companion-safe wrappers for desktop-only Tauri plugin APIs.
 *
 * In the Tauri webview (and in jsdom tests, which mock the plugins) these
 * delegate to the real plugin. In the mobile-companion browser there is no
 * `__TAURI_INTERNALS__` — the real implementations read it and throw — so these
 * degrade gracefully instead of taking down the click handler / render.
 *
 * Only `src/lib/platform-bridge.ts` knows about the plugin transport; callers
 * import the same names from here and are otherwise unchanged.
 */

import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { isCompanionClient } from "./ipc";

// Resolved once at module load; the runtime never switches mid-session.
const COMPANION = isCompanionClient();

/**
 * Open a URL externally. In the desktop webview this hands off to the OS via
 * the opener plugin; in the companion browser it opens a new tab.
 */
export async function openUrl(url: string, openWith?: string): Promise<void> {
	if (COMPANION) {
		window.open(url, "_blank", "noopener,noreferrer");
		return;
	}
	// Preserve call arity so `expect(openUrl).toHaveBeenCalledWith(url)` (no
	// trailing `undefined`) keeps matching — same contract as `invoke` in ipc.ts.
	if (openWith !== undefined) {
		await tauriOpenUrl(url, openWith);
		return;
	}
	await tauriOpenUrl(url);
}
