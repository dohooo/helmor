/**
 * Synchronous platform detection for UI decisions.
 *
 * We use `navigator.userAgent` / `navigator.platform` instead of Tauri's
 * async `@tauri-apps/plugin-os` API so components can render the correct
 * layout on first paint (no hydration flicker between "mac chrome" and
 * "windows chrome"). The userAgent inside Tauri's webview is trustworthy —
 * it's not spoofable by users — so this is accurate enough for cosmetic
 * and keyboard-shortcut decisions. Security-sensitive paths must still go
 * through the Rust side.
 */

export type Platform = "mac" | "windows" | "linux";

function detectPlatform(): Platform {
	if (typeof navigator === "undefined") {
		// Vitest jsdom path: default to mac so existing tests keep passing.
		return "mac";
	}
	const ua = navigator.userAgent.toLowerCase();
	const rawPlatform = (navigator.platform || "").toLowerCase();
	if (ua.includes("mac") || rawPlatform.startsWith("mac")) {
		return "mac";
	}
	if (ua.includes("win") || rawPlatform.startsWith("win")) {
		return "windows";
	}
	// Everything else (X11, Linux, Wayland) falls into "linux".
	return "linux";
}

const CACHED: Platform = detectPlatform();

/** Returns the detected platform, cached at module load. */
export function getPlatform(): Platform {
	return CACHED;
}

/** Convenience: `true` only on macOS. */
export function isMac(): boolean {
	return CACHED === "mac";
}

/** Convenience: `true` on Windows. */
export function isWindows(): boolean {
	return CACHED === "windows";
}

/** Convenience: `true` on Linux / X11 / Wayland. */
export function isLinux(): boolean {
	return CACHED === "linux";
}
