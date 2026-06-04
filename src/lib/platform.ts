export function isMac(): boolean {
	if (typeof navigator === "undefined") return true;
	const nav = navigator as Navigator & {
		userAgentData?: { platform?: string };
	};
	const platform = nav.userAgentData?.platform || navigator.platform || "";
	return /mac/i.test(platform);
}

export function isTauriRuntime(): boolean {
	if (typeof window === "undefined") return false;
	const tauriWindow = window as Window & {
		__TAURI__?: unknown;
		__TAURI_INTERNALS__?: unknown;
	};
	return Boolean(tauriWindow.__TAURI__ || tauriWindow.__TAURI_INTERNALS__);
}
