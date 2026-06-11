import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { isTauriRuntime } from "@/lib/platform";
import { useSettings } from "@/lib/settings";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;

export function clampZoom(value: number): number {
	if (!Number.isFinite(value)) return 1.0;
	const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
	// Snap to 2 decimals so repeated +/- doesn't drift (0.1 isn't exact in fp).
	return Math.round(clamped * 100) / 100;
}

/** Applies the current zoom to the webview whenever the setting changes. */
export function useZoom(): void {
	const { settings } = useSettings();
	const zoom = settings.zoomLevel;

	useEffect(() => {
		// The mobile-companion browser has no Tauri webview. `getCurrentWebview()`
		// reads `__TAURI_INTERNALS__` SYNCHRONOUSLY and throws when it's absent —
		// the `.catch` below only guards the async `setZoom` rejection, NOT that
		// synchronous throw, so without this gate React treats it as a render
		// error and tears down the whole app shell (blank screen). Same failure
		// mode the dock-badge hook documents.
		if (!isTauriRuntime()) return;
		void getCurrentWebview()
			.setZoom(zoom)
			.catch(() => {
				// webview may not be ready yet, or we're in a non-Tauri env
			});
	}, [zoom]);
}

export { ZOOM_STEP };
