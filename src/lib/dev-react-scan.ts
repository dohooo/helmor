/**
 * Dev-only entry point for react-scan.
 *
 * react-scan highlights React components that re-render unnecessarily and
 * surfaces FPS drops / slow interactions as an always-on profiler.
 *
 * Gated behind `VITE_HELMOR_PERF_HUD=1` or `?perfHud=1` in the URL so it
 * never ships in production and stays out of the default dev session.
 */
export function initDevReactScan() {
	if (!import.meta.env.DEV || typeof window === "undefined") {
		return;
	}

	const envFlag = import.meta.env.VITE_HELMOR_PERF_HUD === "1";
	const queryFlag =
		new URLSearchParams(window.location.search).get("perfHud") === "1";

	if (!envFlag && !queryFlag) {
		return;
	}

	// Dynamic import keeps react-scan fully out of the bundle unless the flag
	// is on. The module has side effects during construction so it must be
	// imported, not tree-shaken.
	void import("react-scan").then(({ scan }) => {
		scan({ enabled: true });
	});
}
